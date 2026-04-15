"""
Thin wrapper around faster-whisper's ``WhisperModel``.

The model is loaded lazily (so the API can boot without CUDA and fail
gracefully at first use) and cached keyed by (model_name, device, compute_type).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional

log = logging.getLogger(__name__)

_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
_LOAD_LOCK = threading.Lock()


@dataclass
class Segment:
    start: float
    end: float
    text: str


def resolve_device(device: str) -> str:
    """Translate 'auto' into 'cuda' if available, else 'cpu'."""
    if device and device != "auto":
        return device
    try:
        import ctranslate2  # type: ignore

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


def load_model(
    name: str,
    *,
    models_dir: Path,
    device: str,
    compute_type: str,
):
    """Load or return a cached faster-whisper WhisperModel."""
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "faster-whisper is not installed or importable. "
            "Run `pip install faster-whisper`."
        ) from exc

    effective_device = resolve_device(device)
    key = (name, effective_device, compute_type)
    with _LOAD_LOCK:
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            return cached
        log.info(
            "Loading Whisper model %r on %s (%s), cache=%s",
            name, effective_device, compute_type, models_dir,
        )
        (models_dir / "whisper").mkdir(parents=True, exist_ok=True)
        model = WhisperModel(
            name,
            device=effective_device,
            compute_type=compute_type,
            download_root=str(models_dir / "whisper"),
        )
        _MODEL_CACHE[key] = model
        return model


def transcribe(
    model,
    audio_path: Path,
    *,
    language: Optional[str],
    task: str,
    beam_size: int,
    temperature: float,
    initial_prompt: Optional[str],
    vad_filter: bool,
    vad_parameters: dict,
) -> tuple[Iterator[Segment], float]:
    """
    Run transcription. Returns a segment iterator and the detected audio duration
    (used for progress calculation). The iterator must be consumed for work to
    actually happen (faster-whisper is lazy).
    """
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language or None,
        task=task,
        beam_size=beam_size,
        temperature=temperature,
        initial_prompt=initial_prompt,
        vad_filter=vad_filter,
        vad_parameters=vad_parameters if vad_filter else None,
    )
    duration = float(getattr(info, "duration", 0.0) or 0.0)

    def _wrap() -> Iterator[Segment]:
        for s in segments_iter:
            yield Segment(start=float(s.start), end=float(s.end), text=str(s.text).strip())

    return _wrap(), duration
