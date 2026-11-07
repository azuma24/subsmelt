from __future__ import annotations

import os
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

from .engine import TranscriptionCancelled

# Generous ceiling so legitimately long media still extracts, while a hung or
# stuck ffmpeg cannot block the worker thread forever.
DEFAULT_FFMPEG_TIMEOUT_SECONDS = 30 * 60
# How often a running ffmpeg is checked for a client cancel.
CANCEL_POLL_SECONDS = 0.5

# Probe standalone media by content. Playlists, image sequences, and other
# demuxers that can open additional inputs are deliberately absent. MOV/MP4's
# external data references are disabled by FFmpeg unless explicitly enabled.
LOCAL_MEDIA_FORMATS = (
    "aac,ac3,aiff,alac,amr,ape,asf,asf_o,au,avi,caf,dts,eac3,flac,flv,matroska,"
    "webm,mov,mp4,m4a,3gp,3g2,mj2,mp3,mpeg,mpegts,mpegtsraw,ogg,rm,truehd,wav,w64,wv"
)


def local_media_input(path: Path, *, formats: str = LOCAL_MEDIA_FORMATS) -> list[str]:
    return ["-protocol_whitelist", "file", "-format_whitelist", formats, "-i", str(path.absolute())]


def ffmpeg_binary() -> str:
    """Resolve the ffmpeg executable to invoke.

    Resolution order (Phase 3 Windows packaging):
      1. ``SUBSMELT_FFMPEG`` env var — set by the packaged launcher
         (``run_server.py``) to the bundled ``ffmpeg.exe`` so we never depend on
         the system PATH on a Windows service host.
      2. ``ffmpeg`` on PATH — the existing/default behavior for Docker, local
         dev, and any environment where ffmpeg is already installed.

    Additive only: when ``SUBSMELT_FFMPEG`` is unset (every current deployment
    and the test suite), this returns ``"ffmpeg"`` exactly as before.
    """
    return os.environ.get("SUBSMELT_FFMPEG") or "ffmpeg"


class AudioStreamSelectionError(RuntimeError):
    """The explicit stream index did not point to an audio stream."""


def extract_audio(
    input_path: Path,
    output_path: Path,
    timeout_seconds: int = DEFAULT_FFMPEG_TIMEOUT_SECONDS,
    is_cancelled: Callable[[], bool] | None = None,
    *,
    stream_index: int | None = None,
) -> Path:
    """Decode ``input_path`` to 16 kHz mono WAV. A cancel (``is_cancelled``
    turning True) or the timeout kills ffmpeg rather than waiting it out."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [ffmpeg_binary(), "-nostdin", "-y", *local_media_input(input_path)]
    if stream_index is not None:
        # FFmpeg normalizes the input to media start. Preserve lead-in silence
        # on a later-starting track instead of letting WAV reset it to zero.
        command += ["-map", f"0:{stream_index}", "-af", "aresample=16000:async=1:first_pts=0"]
    command += ["-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-f", "wav", str(output_path)]
    returncode, raw_stderr = _run_ffmpeg(command, input_path, timeout_seconds, is_cancelled)
    stderr = raw_stderr.decode("utf-8", errors="replace").strip()

    if returncode != 0:
        if stream_index is not None and (_looks_like_no_audio(stderr) or "matches no streams" in stderr.lower()):
            raise AudioStreamSelectionError(f"Audio stream {stream_index} does not exist in this media file")
        if _looks_like_no_audio(stderr):
            raise RuntimeError(f"Input media has no audio track: {input_path}")
        detail = f"\n{stderr}" if stderr else ""
        raise RuntimeError(f"ffmpeg failed (exit code {returncode}) extracting audio from {input_path}:{detail}")

    # ffmpeg can succeed (exit 0) yet produce nothing when there is no audio stream.
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError(f"Input media produced no audio output (likely no audio track): {input_path}")

    return output_path


def _run_ffmpeg(
    command: list[str],
    input_path: Path,
    timeout_seconds: int,
    is_cancelled: Callable[[], bool] | None,
) -> tuple[int, bytes]:
    """Run ffmpeg to completion, polling for a cancel; returns (exit code, stderr)."""
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            _, stderr = process.communicate(timeout=CANCEL_POLL_SECONDS)
            return process.returncode, stderr or b""
        except subprocess.TimeoutExpired:
            pass
        if is_cancelled is not None and is_cancelled():
            _kill(process)
            raise TranscriptionCancelled("Transcription cancelled by client")
        if time.monotonic() >= deadline:
            _kill(process)
            raise RuntimeError(f"ffmpeg timed out after {timeout_seconds}s extracting audio from {input_path}")


def _kill(process: subprocess.Popen) -> None:
    process.kill()
    process.communicate()


def _looks_like_no_audio(stderr: str) -> bool:
    lowered = stderr.lower()
    return (
        "does not contain any stream" in lowered
        or "output file does not contain any stream" in lowered
        or "audio: none" in lowered
    )
