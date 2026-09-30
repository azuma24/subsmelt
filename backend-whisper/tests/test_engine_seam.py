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


def _copy_instead_of_ffmpeg(src: Path, dst: Path) -> Path:
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
            },
        )
        self.assertEqual((self.media / "clip.txt").read_text(), "first cue\nsecond cue\n")

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
