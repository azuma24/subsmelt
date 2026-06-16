from __future__ import annotations

import os
import subprocess
from pathlib import Path

# Generous ceiling so legitimately long media still extracts, while a hung or
# stuck ffmpeg cannot block the worker thread forever.
DEFAULT_FFMPEG_TIMEOUT_SECONDS = 30 * 60


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


def extract_audio(
    input_path: Path,
    output_path: Path,
    timeout_seconds: int = DEFAULT_FFMPEG_TIMEOUT_SECONDS,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg_binary(),
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(output_path),
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"ffmpeg timed out after {timeout_seconds}s extracting audio from {input_path}"
        ) from exc

    stderr = (result.stderr or b"").decode("utf-8", errors="replace").strip()

    if result.returncode != 0:
        if _looks_like_no_audio(stderr):
            raise RuntimeError(
                f"Input media has no audio track: {input_path}"
            )
        detail = f"\n{stderr}" if stderr else ""
        raise RuntimeError(
            f"ffmpeg failed (exit code {result.returncode}) extracting audio from {input_path}:{detail}"
        )

    # ffmpeg can succeed (exit 0) yet produce nothing when there is no audio stream.
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError(
            f"Input media produced no audio output (likely no audio track): {input_path}"
        )

    return output_path


def _looks_like_no_audio(stderr: str) -> bool:
    lowered = stderr.lower()
    return (
        "does not contain any stream" in lowered
        or "output file does not contain any stream" in lowered
        or "audio: none" in lowered
    )
