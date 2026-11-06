from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app import transcribe, transcript_checkpoint
from app.schemas import TranscribeRequest
from app.segments import snap_start_to_words


@pytest.fixture
def pipeline(tmp_path: Path, monkeypatch):
    media = tmp_path / "movie.mkv"
    media.write_bytes(b"original media")
    model = tmp_path / "custom-model"
    model.mkdir()
    weights = model / "model.bin"
    weights.write_bytes(b"weights")
    artifacts = tmp_path / "checkpoints"
    monkeypatch.setenv("SUBSMELT_WHISPER_CHECKPOINTS", "1")
    monkeypatch.setenv("SUBSMELT_WHISPER_CHECKPOINT_DIR", str(artifacts))
    calls = []

    def recognize(request, audio_path, is_cancelled, interval):
        calls.append(request)
        word = SimpleNamespace(start=0.25, end=0.9, word="first cue")
        raw = [SimpleNamespace(start=0.0, end=1.0, text="first cue", words=[word])]
        yield {"type": "progress", "pct": 100}
        return [snap_start_to_words(segment) for segment in raw], SimpleNamespace(
            language="de", duration=1.0, raw_segments=raw, model_load_ms=0
        )

    def extract(input_path, output, **kwargs):
        output.write_bytes(input_path.read_bytes())
        return output

    monkeypatch.setitem(transcribe.ENGINE_RUNNERS, "whisper", recognize)
    monkeypatch.setattr(transcribe, "extract_audio", extract)
    request = TranscribeRequest(input_path=str(media), model=str(model))
    return request, media, weights, artifacts, calls


def test_render_failure_leaves_raw_words_for_a_format_change(pipeline):
    request, media, _, artifacts, calls = pipeline
    with patch.object(transcribe, "write_transcript", side_effect=OSError("renderer failed")):
        with pytest.raises(OSError, match="renderer failed"):
            transcribe.run_transcription(request, media, deliver="path")
    assert not media.with_suffix(".srt").exists()
    [artifact] = artifacts.glob("*.json")
    raw = transcript_checkpoint.RawTranscript.model_validate_json(artifact.read_bytes())
    assert raw.version == 1
    assert raw.language == "de"
    assert raw.segments[0].start == 0.0
    assert raw.segments[0].words[0].start == 0.25

    edited = request.model_copy(update={"output_format": "vtt"})
    replay = transcribe.run_transcription(edited, media, deliver="path")
    assert replay["checkpoint_hit"] is True
    assert set(replay["timings_ms"]) == {"checkpoint", "render"}
    assert replay["language"] == "de"
    assert media.with_suffix(".vtt").read_text().endswith("00:00:00.250 --> 00:00:01.000\nfirst cue\n")
    assert len(calls) == 1


def test_changed_media_model_and_decode_options_invalidate_the_checkpoint(pipeline):
    request, media, weights, _, calls = pipeline

    def hit(**options):
        payload = request.model_dump()
        payload.update(options)
        return transcribe.run_transcription(TranscribeRequest(**payload), media, deliver="path")["checkpoint_hit"]

    assert hit() is False
    assert hit() is True
    assert hit(force_recognition=True) is False
    assert hit() is True
    assert hit(language="de") is False
    assert hit(use_vad=False) is False
    assert hit(advanced_options={"beam_size": 4}) is False
    assert hit(audio_stream_index=2) is False

    before = media.stat()
    replacement = media.with_name("replacement.mkv")
    replacement.write_bytes(b"changed media!")
    os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
    replacement.replace(media)
    assert hit() is False
    weights.write_bytes(b"other weights")
    assert hit() is False
    assert len(calls) == 8


def test_a_media_change_during_recognition_prevents_checkpoint_and_publication(pipeline, monkeypatch):
    request, media, _, artifacts, _ = pipeline
    recognize = transcribe.ENGINE_RUNNERS["whisper"]

    def changing_recognizer(*args):
        result = yield from recognize(*args)
        media.write_bytes(b"media replaced during recognition")
        return result

    monkeypatch.setitem(transcribe.ENGINE_RUNNERS, "whisper", changing_recognizer)
    with pytest.raises(RuntimeError, match="Media file changed during transcription"):
        transcribe.run_transcription(request, media, deliver="path")
    assert not media.with_suffix(".srt").exists()
    assert not artifacts.exists()


def test_upload_reuses_content_across_temporary_paths_and_recovers_a_corrupt_artifact(pipeline):
    request, media, _, artifacts, calls = pipeline

    def hit(input_path: Path, **options):
        return transcribe.run_transcription(request.model_copy(update=options), input_path, deliver="content")[
            "checkpoint_hit"
        ]

    assert hit(media) is False
    moved = media.with_name("new-upload-name.mkv")
    media.rename(moved)
    assert hit(moved) is True
    assert hit(moved, source_audio_stream_index=2) is False
    assert hit(moved, source_audio_stream_index=3) is False
    for artifact in artifacts.glob("*.json"):
        artifact.write_text('{"version": 0}')
    assert hit(moved) is False
    assert hit(moved) is True
    moved.write_bytes(b"different upload")
    assert hit(moved) is False
    assert len(calls) == 5


def test_retention_prunes_old_entries_without_leaving_temporary_files(pipeline, monkeypatch):
    request, media, _, artifacts, _ = pipeline
    monkeypatch.setattr(transcript_checkpoint, "_MAX_FILES", 2)
    for language in ("en", "de", "ja"):
        item = request.model_copy(update={"language": language})
        transcribe.run_transcription(item, media, deliver="content")
    assert len(list(artifacts.glob("*.json"))) == 2
    assert not list(artifacts.glob("*.tmp"))
