"""The transcription pipeline: extract audio, run the model's engine, diarize,
render subtitles. Engines plug in through :data:`ENGINE_RUNNERS`."""
from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Generator, Iterator, Literal

from . import nemotron, whisper_engine
from .audio import extract_audio
from .catalog import descriptor_for
from .chinese_script import convert_segments, is_chinese
from .diarize import assign_speakers, fake_assign_speakers
from .engine import EngineRunner, LanguageNotSupportedError, TranscriptionCancelled, progress_event
from .formatters import write_transcript
from .nemotron_languages import fold_iso3, normalize_language
from .paths import output_path_for
from .schemas import TranscribeRequest
from .segments import clamp_to_duration, postprocess_segments

# "path" writes the subtitle next to the input on the shared media root and
# returns its path; "content" returns the rendered subtitle as a string (the
# upload transport, where the client writes the file itself).
Deliver = Literal["path", "content"]

ENGINE_RUNNERS: dict[str, EngineRunner] = {
    "whisper": whisper_engine.run,
    "nemotron": nemotron.run,
}


def engine_runner(model: str) -> EngineRunner:
    """The runner for a model id; unknown ids and local paths are Whisper."""
    descriptor = descriptor_for(model)
    return ENGINE_RUNNERS[descriptor.engine if descriptor else "whisper"]


def assert_language_supported(request: TranscribeRequest) -> None:
    lang = normalize_language((request.language or "auto").strip())
    descriptor = descriptor_for(request.model)
    if lang in ("", "auto") or descriptor is None or descriptor.accepts_language(lang):
        return
    raise LanguageNotSupportedError(
        request.model,
        request.language,
        f"Model {request.model!r} does not support language {request.language!r}. "
        f"Use large-v3 or large-v3-turbo.",
    )


def unsupported_advanced_features(request: TranscribeRequest) -> list[str]:
    options = request.advanced_options
    if not options:
        return []
    unsupported: list[str] = []
    if options.bgm_separation:
        unsupported.append("bgm_separation")
    return unsupported


def assert_supported_advanced_features(request: TranscribeRequest) -> None:
    # Language check lives here so every transcribe path (real + fake) rejects
    # an unsupported language before ffmpeg/model load.
    assert_language_supported(request)
    unsupported = unsupported_advanced_features(request)
    if unsupported:
        joined = ", ".join(unsupported)
        raise RuntimeError(f"Advanced STT feature not available in this lightweight backend: {joined}")


def _diarization_requested(request: TranscribeRequest) -> bool:
    opts = request.advanced_options
    return bool(opts and opts.speaker_diarization)


def _maybe_diarize(collected: list, audio_path: Path, request: TranscribeRequest) -> list:
    """Tag segments with speakers when diarization is requested (real pipeline)."""
    if not _diarization_requested(request):
        return collected
    opts = request.advanced_options
    return assign_speakers(
        collected,
        audio_path,
        request.device,
        min_speakers=opts.min_speakers,
        max_speakers=opts.max_speakers,
    )


def _maybe_fake_diarize(collected: list, request: TranscribeRequest) -> list:
    """Diarization for the fake (no-pyannote) test paths."""
    if not _diarization_requested(request):
        return collected
    return fake_assign_speakers(collected)


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


def _finalize(segments: list, info: object, request: TranscribeRequest, input_path: Path, deliver: Deliver) -> dict:
    """Render the subtitle and build the result payload for either transport."""
    # Speech models invent tail text on trailing silence, and their timestamps
    # are estimates that can run past the file. The decoded audio duration is
    # the authority: clamp every cue to it before merge/split can inherit the
    # out-of-range clock.
    duration = getattr(info, "duration", None)
    if duration:
        segments = clamp_to_duration(segments, duration)
    processed = apply_subtitle_quality(segments, request)
    # A direct API call may carry an ISO-639-2 code ("kor"); the file suffix
    # and the reported language both use the short code ("ko").
    language = fold_iso3(request.language or "auto")
    detected = getattr(info, "language", None)
    chinese_script = _chinese_script_for(request, language, detected)
    if chinese_script:
        processed = convert_segments(processed, chinese_script)
    count, delivered = _deliver(processed, request, input_path, language, deliver)
    # Never report the literal "auto" — if detection produced nothing, return the
    # explicit language (when given) or None, not the sentinel.
    return {
        "ok": True,
        **delivered,
        "language": fold_iso3(detected) if detected else (None if language in ("", "auto") else language),
        "segments": count,
        "duration_seconds": getattr(info, "duration", None),
        "chinese_script": chinese_script,
    }


def _chinese_script_for(request: TranscribeRequest, language: str, detected: str | None) -> str | None:
    """The script to convert to: the request's preference, when the requested
    language (or, on auto, the detected one) is Chinese."""
    transcript_language = detected if language in ("", "auto") else language
    return request.chinese_script if is_chinese(transcript_language) else None


def _deliver(processed: list, request: TranscribeRequest, input_path: Path, language: str, deliver: Deliver) -> tuple[int, dict]:
    """Write the subtitle beside the input ("path") or render it to a string
    ("content"); returns (cue count, the transport's payload fields)."""
    if not any((getattr(segment, "text", "") or "").strip() for segment in processed):
        # Nothing spoken (VAD removed it all): an empty file would read as a
        # finished transcript, so shared mode writes none.
        return 0, ({"subtitle_path": None} if deliver == "path" else {"content": ""})
    max_line_length = request.subtitle_quality.max_line_length if request.subtitle_quality else None
    if deliver == "path":
        output_path = output_path_for(input_path, language, request.output_format)
        count = write_transcript(processed, output_path, request.output_format, max_line_length=max_line_length)
        return count, {"subtitle_path": str(output_path)}
    with tempfile.TemporaryDirectory(prefix="subsmelt-whisper-out-") as out_tmp:
        out_path = Path(out_tmp) / f"transcript.{request.output_format}"
        count = write_transcript(processed, out_path, request.output_format, max_line_length=max_line_length)
        return count, {"content": out_path.read_text(encoding="utf-8")}


def _raise_if_cancelled(is_cancelled: Callable[[], bool] | None) -> None:
    if is_cancelled is not None and is_cancelled():
        raise TranscriptionCancelled("Transcription cancelled by client")


def run_transcription_streaming(
    request: TranscribeRequest,
    input_path: Path,
    is_cancelled: Callable[[], bool] | None = None,
    min_progress_interval: float = 1.0,
    *,
    deliver: Deliver,
) -> Generator[dict, None, dict]:
    """Yield ``progress`` dicts, then a terminal ``result`` dict, which is also
    the generator's return value (for :func:`run_transcription`).

    The temporary ffmpeg scratch directory is always removed via the context
    manager, including when the caller cancels (``is_cancelled`` returns True →
    ``TranscriptionCancelled``).
    """
    assert_supported_advanced_features(request)
    runner = engine_runner(request.model)
    with tempfile.TemporaryDirectory(prefix="subsmelt-whisper-") as tmp:
        audio_path = extract_audio(input_path, Path(tmp) / "audio.wav", is_cancelled=is_cancelled)
        segments, info = yield from runner(request, audio_path, is_cancelled, min_progress_interval)
        if _diarization_requested(request):
            _raise_if_cancelled(is_cancelled)
            yield {"type": "phase", "phase": "diarizing"}
            segments = _maybe_diarize(segments, audio_path, request)
        # Diarization cannot be interrupted; never write a subtitle the client
        # already walked away from.
        _raise_if_cancelled(is_cancelled)
        result = _finalize(segments, info, request, input_path, deliver)
        yield {**result, "type": "result"}
        return result


def run_transcription(request: TranscribeRequest, input_path: Path, *, deliver: Deliver) -> dict:
    """Blocking transcription: drains the streaming pipeline, returns its result."""
    events = run_transcription_streaming(request, input_path, deliver=deliver)
    while True:
        try:
            next(events)
        except StopIteration as done:
            return done.value


_FAKE_SEGMENTS = (
    SimpleNamespace(start=0.0, end=0.75, text="Test transcription"),
    SimpleNamespace(start=0.75, end=1.5, text="second line"),
)


def fake_transcribe_streaming_for_tests(
    input_path: Path,
    request: TranscribeRequest,
    is_cancelled: Callable[[], bool] | None = None,
    *,
    deliver: Deliver = "path",
) -> Iterator[dict]:
    """The pipeline without ffmpeg or a model: canned segments, progress lines,
    then the terminal result, so the NDJSON protocol can be exercised in tests."""
    assert_supported_advanced_features(request)
    total_seconds = _FAKE_SEGMENTS[-1].end
    collected: list = []
    for segment in _FAKE_SEGMENTS:
        if is_cancelled is not None and is_cancelled():
            raise TranscriptionCancelled("Transcription cancelled by client")
        collected.append(segment)
        yield progress_event(segment.end, total_seconds)
    collected = _maybe_fake_diarize(collected, request)
    _raise_if_cancelled(is_cancelled)
    info = SimpleNamespace(language=request.language, duration=total_seconds)
    yield {**_finalize(collected, info, request, input_path, deliver), "type": "result"}


def fake_transcribe_for_tests(input_path: Path, request: TranscribeRequest, *, deliver: Deliver = "path") -> dict:
    result = None
    for event in fake_transcribe_streaming_for_tests(input_path, request, deliver=deliver):
        result = event
    return {key: value for key, value in result.items() if key != "type"}
