"""The pipeline around an engine runner: audio in, runner progress out, one
terminal result whichever transport delivers it."""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

try:
    from fastapi.testclient import TestClient

    import app.main as main_module
    import app.transcribe as transcribe
    from app.schemas import TranscribeRequest
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TestClient = None
    main_module = None
    transcribe = None
    TranscribeRequest = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


def _copy_instead_of_ffmpeg(src: Path, dst: Path, is_cancelled=None) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, dst)
    return dst


def _stub_runner(request, audio_path, is_cancelled, min_progress_interval):
    yield {"type": "progress", "processedSeconds": 1.0, "totalSeconds": 2.0, "pct": 50.0}
    segments = [
        SimpleNamespace(start=0.0, end=1.0, text="first cue"),
        SimpleNamespace(start=1.0, end=2.0, text="second cue"),
    ]
    return segments, SimpleNamespace(language="de", duration=2.0)


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
class EngineSeamTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.media = Path(self._tmp.name)
        (self.media / "clip.mkv").write_bytes(b"x")
        self._patches = [
            mock.patch.object(transcribe, "extract_audio", _copy_instead_of_ffmpeg),
            mock.patch.dict(transcribe.ENGINE_RUNNERS, {"whisper": _stub_runner}),
        ]
        for patch in self._patches:
            patch.start()

    def tearDown(self):
        for patch in self._patches:
            patch.stop()
        self._tmp.cleanup()

    def _request(self, **overrides) -> "TranscribeRequest":
        return TranscribeRequest(input_path=str(self.media / "clip.mkv"), model="small", language="auto", **overrides)

    def test_streaming_yields_runner_progress_then_the_rendered_result(self):
        events = list(transcribe.run_transcription_streaming(self._request(), self.media / "clip.mkv", deliver="content"))
        self.assertEqual(
            events,
            [
                {"type": "progress", "processedSeconds": 1.0, "totalSeconds": 2.0, "pct": 50.0},
                {
                    "type": "result",
                    "ok": True,
                    "content": "1\n00:00:00,000 --> 00:00:01,000\nfirst cue\n\n2\n00:00:01,000 --> 00:00:02,000\nsecond cue\n",
                    "language": "de",
                    "segments": 2,
                    "duration_seconds": 2.0,
                    "chinese_script": None,
                },
            ],
        )

    def test_blocking_call_returns_the_streamed_result_and_writes_next_to_the_input(self):
        result = transcribe.run_transcription(self._request(output_format="txt"), self.media / "clip.mkv", deliver="path")
        self.assertEqual(
            result,
            {
                "ok": True,
                "subtitle_path": str(self.media / "clip.txt"),
                "language": "de",
                "segments": 2,
                "duration_seconds": 2.0,
                "chinese_script": None,
            },
        )
        self.assertEqual((self.media / "clip.txt").read_text(), "first cue\nsecond cue\n")

    def _cancel_once_the_runner_returns(self):
        """An ``is_cancelled`` that turns True after the engine finishes, the
        moment a client disconnect during diarization or rendering looks like."""
        state = {"runner_done": False}

        def runner(request, audio_path, is_cancelled, min_progress_interval):
            segments, info = yield from _stub_runner(request, audio_path, is_cancelled, min_progress_interval)
            state["runner_done"] = True
            return segments, info

        return runner, lambda: state["runner_done"]

    def test_cancel_after_the_engine_writes_no_subtitle(self):
        runner, is_cancelled = self._cancel_once_the_runner_returns()
        with mock.patch.dict(transcribe.ENGINE_RUNNERS, {"whisper": runner}):
            events = transcribe.run_transcription_streaming(
                self._request(), self.media / "clip.mkv", is_cancelled, deliver="path"
            )
            with self.assertRaises(transcribe.TranscriptionCancelled):
                list(events)
        self.assertFalse((self.media / "clip.srt").exists())

    def test_cancel_is_checked_before_diarization_starts(self):
        runner, is_cancelled = self._cancel_once_the_runner_returns()
        request = self._request(advanced_options={"speaker_diarization": True})
        with mock.patch.dict(transcribe.ENGINE_RUNNERS, {"whisper": runner}), \
             mock.patch.object(transcribe, "assign_speakers") as diarize:
            with self.assertRaises(transcribe.TranscriptionCancelled):
                list(transcribe.run_transcription_streaming(request, self.media / "clip.mkv", is_cancelled, deliver="path"))
        diarize.assert_not_called()
        self.assertFalse((self.media / "clip.srt").exists())

    def test_audio_extraction_receives_the_cancel_check(self):
        seen = {}

        def extract(src, dst, is_cancelled=None):
            seen["is_cancelled"] = is_cancelled
            return _copy_instead_of_ffmpeg(src, dst)

        def is_cancelled():
            return False

        with mock.patch.object(transcribe, "extract_audio", extract):
            list(transcribe.run_transcription_streaming(self._request(), self.media / "clip.mkv", is_cancelled, deliver="content"))
        self.assertIs(seen["is_cancelled"], is_cancelled)

    def _silent_runner(self, request, audio_path, is_cancelled, min_progress_interval):
        # VAD removed everything: no segments, or only whitespace ones.
        yield {"type": "progress", "processedSeconds": 2.0, "totalSeconds": 2.0, "pct": 100.0}
        return [SimpleNamespace(start=0.0, end=1.0, text="  ")], SimpleNamespace(language="en", duration=2.0)

    def test_no_speech_in_shared_mode_reports_zero_segments_and_writes_nothing(self):
        with mock.patch.dict(transcribe.ENGINE_RUNNERS, {"whisper": self._silent_runner}):
            result = transcribe.run_transcription(self._request(), self.media / "clip.mkv", deliver="path")
        self.assertEqual(
            result,
            {"ok": True, "subtitle_path": None, "language": "en", "segments": 0, "duration_seconds": 2.0, "chinese_script": None},
        )
        self.assertEqual(sorted(p.name for p in self.media.iterdir()), ["clip.mkv"])

    def test_no_speech_in_upload_mode_returns_empty_content(self):
        with mock.patch.dict(transcribe.ENGINE_RUNNERS, {"whisper": self._silent_runner}):
            result = transcribe.run_transcription(self._request(), self.media / "clip.mkv", deliver="content")
        self.assertEqual(result["content"], "")
        self.assertEqual(result["segments"], 0)

    def test_unknown_model_ids_use_the_whisper_runner(self):
        self.assertIs(transcribe.engine_runner("/models/custom-ct2"), _stub_runner)
        self.assertIs(transcribe.engine_runner("Small"), _stub_runner)


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
class LanguageErrorOverHttpTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        self._fake = mock.patch.object(main_module, "USE_FAKE_TRANSCRIBE", True)
        self._fake.start()
        self._tmp = tempfile.TemporaryDirectory()
        self.media = Path(self._tmp.name)
        (self.media / "clip.mkv").write_bytes(b"x")
        self.client = TestClient(main_module.app)

    def tearDown(self):
        self._tmp.cleanup()
        self._fake.stop()

    def test_json_endpoint_reports_language_not_supported(self):
        with mock.patch.object(main_module, "MEDIA_ROOT", str(self.media)), \
             mock.patch.object(main_module, "available_ram_mb", return_value=64000), \
             mock.patch.object(main_module, "ffmpeg_available", return_value=True), \
             mock.patch.object(main_module, "assert_model_downloaded", return_value=None):
            resp = self.client.post(
                "/transcribe",
                json={"input_path": str(self.media / "clip.mkv"), "model": "distil-large-v3", "language": "ja"},
            )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            resp.json()["detail"],
            {
                "code": "language_not_supported",
                "message": "Model 'distil-large-v3' does not support language 'ja'. Use large-v3 or large-v3-turbo.",
                "model": "distil-large-v3",
                "language": "ja",
            },
        )


if __name__ == "__main__":
    unittest.main()
