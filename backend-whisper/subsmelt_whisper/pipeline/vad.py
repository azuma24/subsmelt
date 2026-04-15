"""
Silero VAD wrapper.

faster-whisper ships with a Silero VAD integration, so we don't need to pre-run
it ourselves — we just translate the subsmelt-shaped request into the
``vad_parameters`` argument the whisper runner accepts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class VadOptions:
    enabled: bool = True
    min_silence_duration_ms: int = 500
    speech_pad_ms: int = 400
    threshold: float = 0.5

    def to_whisper_params(self) -> dict[str, Any]:
        # See faster-whisper's VadOptions.
        return {
            "threshold": self.threshold,
            "min_silence_duration_ms": self.min_silence_duration_ms,
            "speech_pad_ms": self.speech_pad_ms,
        }


def vad_from_request(payload: dict[str, Any] | None) -> VadOptions:
    if not payload:
        return VadOptions()
    return VadOptions(
        enabled=bool(payload.get("enabled", True)),
        min_silence_duration_ms=int(payload.get("min_silence_ms", 500)),
        speech_pad_ms=int(payload.get("speech_pad_ms", 400)),
        threshold=float(payload.get("threshold", 0.5)),
    )
