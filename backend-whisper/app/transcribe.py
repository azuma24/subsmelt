from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

from .audio import extract_audio
from .formatters import write_transcript
from .paths import output_path_for
from .schemas import TranscribeRequest, TranscribeResponse


def run_faster_whisper(request: TranscribeRequest, input_path: Path) -> TranscribeResponse:
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on optional runtime package
        raise RuntimeError("faster-whisper is not installed in this backend") from exc

    output_path = output_path_for(input_path, request.language, request.output_format)
    with tempfile.TemporaryDirectory(prefix="subsmelt-whisper-") as tmp:
        audio_path = extract_audio(input_path, Path(tmp) / "audio.wav")
        model = WhisperModel(request.model, device=request.device, compute_type=request.compute_type)
        language = None if request.language == "auto" else request.language
        segments_iter, info = model.transcribe(str(audio_path), language=language, vad_filter=request.use_vad)
        segments = list(segments_iter)
        count = write_transcript(segments, output_path, request.output_format)
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
    output_path = output_path_for(input_path, request.language, request.output_format)
    segment = SimpleNamespace(start=0.0, end=1.5, text="Test transcription")
    count = write_transcript([segment], output_path, request.output_format)
    return TranscribeResponse(ok=True, subtitle_path=str(output_path), language=request.language, segments=count, duration_seconds=1.5)
