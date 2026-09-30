"""The faster-whisper engine runner."""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Generator

from .engine import TranscriptionCancelled, progress_event
from .model_loader import CudaOutOfMemoryError, _is_cuda_oom, lease
from .schemas import TranscribeRequest


def faster_whisper_transcribe_kwargs(request: TranscribeRequest) -> dict:
    options = request.advanced_options
    kwargs = {
        "language": None if request.language == "auto" else request.language,
        "vad_filter": request.use_vad,
    }
    if options:
        if options.beam_size is not None:
            kwargs["beam_size"] = options.beam_size
        if options.patience is not None:
            kwargs["patience"] = options.patience
        if options.condition_on_previous_text is not None:
            kwargs["condition_on_previous_text"] = options.condition_on_previous_text
        if options.word_timestamps is not None:
            kwargs["word_timestamps"] = options.word_timestamps
        if options.initial_prompt:
            kwargs["initial_prompt"] = options.initial_prompt
    return kwargs


def _raise_if_cuda_oom(exc: Exception, model: str) -> None:
    """Re-raise a CUDA OOM as a typed error suggesting a smaller model.

    No-op for non-OOM exceptions (the caller re-raises the original).
    """
    if isinstance(exc, CudaOutOfMemoryError):
        raise exc
    if _is_cuda_oom(exc):
        raise CudaOutOfMemoryError(
            f"CUDA ran out of memory transcribing with model {model!r}; try a "
            f"smaller model (e.g. small or base) or free GPU memory"
        ) from exc


def _require_faster_whisper() -> None:
    try:
        import faster_whisper  # type: ignore  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on optional runtime package
        raise RuntimeError("faster-whisper is not installed in this backend") from exc


def _iter_segments_with_progress(
    segments_iter,
    total_seconds: float,
    collected: list,
    request: TranscribeRequest,
    is_cancelled: Callable[[], bool] | None,
    min_progress_interval: float,
) -> Generator[dict, None, None]:
    """Drive the faster-whisper segment generator, appending to ``collected``.

    Yields throttled ``progress`` dicts as audio time advances and honours
    cooperative cancellation.
    """
    last_emitted = -min_progress_interval
    segment_iterator = iter(segments_iter)
    while True:
        try:
            segment = next(segment_iterator)
        except StopIteration:
            break
        except Exception as exc:  # noqa: BLE001 - OOM can surface mid-iteration
            _raise_if_cuda_oom(exc, request.model)
            raise
        if is_cancelled is not None and is_cancelled():
            raise TranscriptionCancelled("Transcription cancelled by client")
        collected.append(segment)
        processed_seconds = float(getattr(segment, "end", 0.0) or 0.0)
        if processed_seconds - last_emitted >= min_progress_interval:
            last_emitted = processed_seconds
            yield progress_event(processed_seconds, total_seconds)

    if is_cancelled is not None and is_cancelled():
        raise TranscriptionCancelled("Transcription cancelled by client")


def run(
    request: TranscribeRequest,
    audio_path: Path,
    is_cancelled: Callable[[], bool] | None,
    min_progress_interval: float,
) -> Generator[dict, None, tuple[list, object]]:
    """Engine runner: lease the WhisperModel, decode ``audio_path``, return
    ``(segments, info)`` after yielding progress. Segments are produced lazily,
    so CUDA OOM can surface at ``transcribe`` or during iteration."""
    _require_faster_whisper()
    with lease(request.model, request.device, request.compute_type) as model:
        try:
            segments_iter, info = model.transcribe(str(audio_path), **faster_whisper_transcribe_kwargs(request))
        except Exception as exc:  # noqa: BLE001 - surface CUDA OOM as a typed error
            _raise_if_cuda_oom(exc, request.model)
            raise
        total_seconds = float(getattr(info, "duration", 0.0) or 0.0)
        collected: list = []
        yield from _iter_segments_with_progress(
            segments_iter, total_seconds, collected, request, is_cancelled, min_progress_interval
        )
        return collected, info
