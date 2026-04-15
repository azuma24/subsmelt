"""Extract audio from a video file using ffmpeg."""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


def find_ffmpeg() -> str:
    """Locate the ffmpeg binary. Looks next to the executable first (Windows bundle)."""
    here = Path(__file__).resolve().parent.parent.parent
    for candidate in (here / "ffmpeg.exe", here / "bin" / "ffmpeg.exe"):
        if candidate.exists():
            return str(candidate)
    found = shutil.which("ffmpeg")
    if not found:
        raise RuntimeError(
            "ffmpeg not found on PATH and not bundled next to subsmelt-whisper. "
            "Install ffmpeg or reinstall the package."
        )
    return found


def extract_audio(video_path: Path, out_wav: Path, sample_rate: int = 16000) -> Path:
    """
    Decode video/audio → mono WAV at ``sample_rate`` Hz.
    Raises RuntimeError with the captured stderr on failure.
    """
    ffmpeg = find_ffmpeg()
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", str(video_path),
        "-vn",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-f", "wav",
        str(out_wav),
    ]
    log.info("ffmpeg extract: %s -> %s", video_path, out_wav)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed (rc={proc.returncode}): {proc.stderr.strip()}")
    return out_wav


def probe_duration(video_path: Path) -> Optional[float]:
    """Return duration in seconds via ffprobe, or None if it cannot be determined."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    cmd = [
        ffprobe,
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if proc.returncode != 0:
            return None
        return float(proc.stdout.strip())
    except (ValueError, subprocess.TimeoutExpired):
        return None
