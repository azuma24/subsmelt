from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

from .audio import extract_audio
from .formatters import write_transcript
from .model_loader import get_whisper_model
from .paths import output_path_for
from .schemas import TranscribeRequest, TranscribeResponse
from .segments import postprocess_segments


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


def run_faster_whisper(request: TranscribeRequest, input_path: Path) -> TranscribeResponse:
    assert_supported_advanced_features(request)
    try:
        import faster_whisper  # type: ignore  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on optional runtime package
        raise RuntimeError("faster-whisper is not installed in this backend") from exc

    output_path = output_path_for(input_path, request.language, request.output_format)
    with tempfile.TemporaryDirectory(prefix="subsmelt-whisper-") as tmp:
        audio_path = extract_audio(input_path, Path(tmp) / "audio.wav")
        model = get_whisper_model(request.model, request.device, request.compute_type)
        language = None if request.language == "auto" else request.language
        segments_iter, info = model.transcribe(str(audio_path), **faster_whisper_transcribe_kwargs(request))
        segments = apply_subtitle_quality(list(segments_iter), request)
        max_line_length = request.subtitle_quality.max_line_length if request.subtitle_quality else None
        count = write_transcript(segments, output_path, request.output_format, max_line_length=max_line_length)
        detected_language = getattr(info, "language", None) or language or request.language
        duration = getattr(info, "duration", None)
        return TranscribeResponse(
            ok=True,
            subtitle_path=str(output_path),
            language=detected_language,
            segments=count,
            duration_seconds=duration,
        )


def fake_transcribe_for_tests(input_path: Path, request: TranscribeRequest) -> TranscribeResponse:
    assert_supported_advanced_features(request)
    output_path = output_path_for(input_path, request.language, request.output_format)
    segment = SimpleNamespace(start=0.0, end=1.5, text="Test transcription")
    segments = apply_subtitle_quality([segment], request)
    max_line_length = request.subtitle_quality.max_line_length if request.subtitle_quality else None
    count = write_transcript(segments, output_path, request.output_format, max_line_length=max_line_length)
    return TranscribeResponse(ok=True, subtitle_path=str(output_path), language=request.language, segments=count, duration_seconds=1.5)
