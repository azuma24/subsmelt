"""Vocabulary shared by the transcription pipeline and every engine runner.

An engine runner is a generator ``(request, audio_path, is_cancelled,
min_progress_interval)`` that yields progress dicts and returns
``(segments, info)``: segments with ``start``, ``end`` and ``text``, info with
``language`` and ``duration``. This module holds only what runners and their
caller both need, so it imports nothing from the rest of the app.
"""
from __future__ import annotations


class TranscriptionCancelled(RuntimeError):
    """Raised when a caller requests cancellation mid-transcription.

    Raised from inside the temporary-directory context managers so the ffmpeg
    scratch dir (and any chunk dir) is removed before it propagates.
    """


class LanguageNotSupportedError(RuntimeError):
    """The chosen model cannot transcribe the requested language (HTTP 400)."""

    def __init__(self, model: str, language: str, message: str) -> None:
        super().__init__(message)
        self.model = model
        self.language = language


class EngineUnavailableError(RuntimeError):
    """The model's engine cannot run here, e.g. its binary is missing (HTTP 400)."""

    def __init__(self, model: str, message: str) -> None:
        super().__init__(message)
        self.model = model


def progress_event(processed_seconds: float, total_seconds: float) -> dict:
    pct = max(0.0, min(100.0, processed_seconds / total_seconds * 100.0)) if total_seconds > 0 else 0.0
    return {
        "type": "progress",
        "processedSeconds": round(processed_seconds, 3),
        "totalSeconds": round(total_seconds, 3),
        "pct": round(pct, 2),
    }
