from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Iterator

from .audio import extract_audio
from .formatters import write_transcript
from .model_loader import get_whisper_model
from .paths import output_path_for
from .schemas import TranscribeRequest, TranscribeResponse
from .segments import postprocess_segments


class TranscriptionCancelled(RuntimeError):
    """Raised when a caller requests cancellation mid-transcription.

    The streaming path checks a caller-supplied predicate as it iterates the
    faster-whisper segment generator; raising this from inside the temporary
    directory context manager guarantees the ffmpeg audio scratch dir is still
    cleaned up before it propagates.
    """


def unsupported_advanced_features(request: TranscribeRequest) -> list[str]:
    options = request.advanced_options
    if not options:
        return []
    unsupported: list[str] = []
    if options.speaker_diarization:
        unsupported.append("speaker_diarization")
    if options.bgm_separation:
        unsupported.append("bgm_separation")
    return unsupported


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


def assert_supported_advanced_features(request: TranscribeRequest) -> None:
    unsupported = unsupported_advanced_features(request)
    if unsupported:
        joined = ", ".join(unsupported)
        raise RuntimeError(f"Advanced STT feature not available in this lightweight backend: {joined}")


def apply_subtitle_quality(segments: list, request: TranscribeRequest) -> list:
    """Apply merge + duration-split post-processing per the request's quality options.

    Order: merge short segments first, then split by max duration. Line-wrapping
    (max_line_length) is applied afterwards by the formatters. When no options are
    set, the original segments are returned unchanged so behaviour is unchanged.
    """
    quality = request.subtitle_quality
    if not quality or (not quality.merge_short_segments and not quality.max_subtitle_duration):
        return segments
    return postprocess_segments(
        segments,
        merge_short=quality.merge_short_segments,
        max_subtitle_duration=quality.max_subtitle_duration,
    )


def _require_faster_whisper() -> None:
    try:
        import faster_whisper  # type: ignore  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on optional runtime package
        raise RuntimeError("faster-whisper is not installed in this backend") from exc


def _finalize_transcript(
    segments: list,
    info: object,
    request: TranscribeRequest,
    input_path: Path,
    output_path: Path,
) -> TranscribeResponse:
    processed = apply_subtitle_quality(segments, request)
    max_line_length = request.subtitle_quality.max_line_length if request.subtitle_quality else None
    count = write_transcript(processed, output_path, request.output_format, max_line_length=max_line_length)
    language = None if request.language == "auto" else request.language
    detected_language = getattr(info, "language", None) or language or request.language
    duration = getattr(info, "duration", None)
    return TranscribeResponse(
        ok=True,
        subtitle_path=str(output_path),
        language=detected_language,
        segments=count,
        duration_seconds=duration,
    )


def run_faster_whisper(request: TranscribeRequest, input_path: Path) -> TranscribeResponse:
    assert_supported_advanced_features(request)
    _require_faster_whisper()

    output_path = output_path_for(input_path, request.language, request.output_format)
    with tempfile.TemporaryDirectory(prefix="subsmelt-whisper-") as tmp:
        audio_path = extract_audio(input_path, Path(tmp) / "audio.wav")
        model = get_whisper_model(request.model, request.device, request.compute_type)
        segments_iter, info = model.transcribe(str(audio_path), **faster_whisper_transcribe_kwargs(request))
        return _finalize_transcript(list(segments_iter), info, request, input_path, output_path)


def run_faster_whisper_streaming(
    request: TranscribeRequest,
    input_path: Path,
    is_cancelled: Callable[[], bool] | None = None,
    min_progress_interval: float = 1.0,
) -> Iterator[dict]:
    """Iterate the faster-whisper segment generator, yielding progress dicts.

    Yields ``{"type": "progress", "processedSeconds", "totalSeconds", "pct"}``
    as audio is processed (throttled to roughly once per ``min_progress_interval``
    seconds of audio time), then a terminal ``{"type": "result", ...}`` payload
    mirroring the JSON ``/transcribe`` response. The temporary ffmpeg scratch
    directory is always removed via the context manager, including when the
    caller cancels (``is_cancelled`` returns True → ``TranscriptionCancelled``).
    """
    assert_supported_advanced_features(request)
    _require_faster_whisper()

    output_path = output_path_for(input_path, request.language, request.output_format)
    with tempfile.TemporaryDirectory(prefix="subsmelt-whisper-") as tmp:
        audio_path = extract_audio(input_path, Path(tmp) / "audio.wav")
        model = get_whisper_model(request.model, request.device, request.compute_type)
        segments_iter, info = model.transcribe(str(audio_path), **faster_whisper_transcribe_kwargs(request))
        total_seconds = float(getattr(info, "duration", 0.0) or 0.0)

        collected: list = []
        last_emitted = -min_progress_interval
        for segment in segments_iter:
            if is_cancelled is not None and is_cancelled():
                raise TranscriptionCancelled("Transcription cancelled by client")
            collected.append(segment)
            processed_seconds = float(getattr(segment, "end", 0.0) or 0.0)
            if processed_seconds - last_emitted >= min_progress_interval:
                last_emitted = processed_seconds
                pct = (
                    max(0.0, min(100.0, processed_seconds / total_seconds * 100.0))
                    if total_seconds > 0
                    else 0.0
                )
                yield {
                    "type": "progress",
                    "processedSeconds": round(processed_seconds, 3),
                    "totalSeconds": round(total_seconds, 3),
                    "pct": round(pct, 2),
                }

        if is_cancelled is not None and is_cancelled():
            raise TranscriptionCancelled("Transcription cancelled by client")

        response = _finalize_transcript(collected, info, request, input_path, output_path)
        result = response.model_dump()
        result["type"] = "result"
        yield result


def fake_transcribe_for_tests(input_path: Path, request: TranscribeRequest) -> TranscribeResponse:
    assert_supported_advanced_features(request)
    output_path = output_path_for(input_path, request.language, request.output_format)
    segment = SimpleNamespace(start=0.0, end=1.5, text="Test transcription")
    segments = apply_subtitle_quality([segment], request)
    max_line_length = request.subtitle_quality.max_line_length if request.subtitle_quality else None
    count = write_transcript(segments, output_path, request.output_format, max_line_length=max_line_length)
    return TranscribeResponse(ok=True, subtitle_path=str(output_path), language=request.language, segments=count, duration_seconds=1.5)


def fake_transcribe_streaming_for_tests(
    input_path: Path,
    request: TranscribeRequest,
    is_cancelled: Callable[[], bool] | None = None,
) -> Iterator[dict]:
    """Streaming counterpart to ``fake_transcribe_for_tests``.

    Emits a couple of progress lines and a terminal result without requiring
    faster-whisper, so the NDJSON protocol can be exercised in tests.
    """
    assert_supported_advanced_features(request)
    total_seconds = 1.5
    fake_segments = [
        SimpleNamespace(start=0.0, end=0.75, text="Test transcription"),
        SimpleNamespace(start=0.75, end=1.5, text="second line"),
    ]
    collected: list = []
    for segment in fake_segments:
        if is_cancelled is not None and is_cancelled():
            raise TranscriptionCancelled("Transcription cancelled by client")
        collected.append(segment)
        yield {
            "type": "progress",
            "processedSeconds": round(segment.end, 3),
            "totalSeconds": total_seconds,
            "pct": round(segment.end / total_seconds * 100.0, 2),
        }

    output_path = output_path_for(input_path, request.language, request.output_format)
    info = SimpleNamespace(language=request.language, duration=total_seconds)
    response = _finalize_transcript(collected, info, request, input_path, output_path)
    result = response.model_dump()
    result["type"] = "result"
    yield result
