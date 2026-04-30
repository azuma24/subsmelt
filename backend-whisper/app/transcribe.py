from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

from .audio import extract_audio
from .formatters import write_transcript
from .paths import output_path_for
from .schemas import TranscribeRequest, TranscribeResponse


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


def run_faster_whisper(request: TranscribeRequest, input_path: Path) -> TranscribeResponse:
    assert_supported_advanced_features(request)
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on optional runtime package
        raise RuntimeError("faster-whisper is not installed in this backend") from exc

    output_path = output_path_for(input_path, request.language, request.output_format)
    with tempfile.TemporaryDirectory(prefix="subsmelt-whisper-") as tmp:
        audio_path = extract_audio(input_path, Path(tmp) / "audio.wav")
        model = WhisperModel(request.model, device=request.device, compute_type=request.compute_type)
        language = None if request.language == "auto" else request.language
        segments_iter, info = model.transcribe(str(audio_path), **faster_whisper_transcribe_kwargs(request))
        segments = list(segments_iter)
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
    max_line_length = request.subtitle_quality.max_line_length if request.subtitle_quality else None
    count = write_transcript([segment], output_path, request.output_format, max_line_length=max_line_length)
    return TranscribeResponse(ok=True, subtitle_path=str(output_path), language=request.language, segments=count, duration_seconds=1.5)
