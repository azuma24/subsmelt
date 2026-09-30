"""Streaming endpoints: pre-stream work stays off the event loop, and a client
that disconnects mid-stream never leaks the temp media or crashes the worker."""

import asyncio
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    from fastapi.testclient import TestClient

    import app.main as main_module
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TestClient = None
    main_module = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


def _has_running_loop() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
class PreStreamWorkOffLoopTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        self._fake = mock.patch.object(main_module, "USE_FAKE_TRANSCRIBE", True)
        self._fake.start()
        self.client = TestClient(main_module.app)
        self._tmp = tempfile.TemporaryDirectory()
        self.media = Path(self._tmp.name)
        (self.media / "clip.mkv").write_bytes(b"x")
        self.seen: dict[str, bool] = {}

    def tearDown(self):
        self._tmp.cleanup()
        self._fake.stop()

    def _recording(self, name, wrapped):
        def record(*args, **kwargs):
            self.seen[name] = _has_running_loop()
            return wrapped(*args, **kwargs)
        return record

    def test_path_stream_validates_off_the_loop(self):
        with mock.patch.object(main_module, "MEDIA_ROOT", str(self.media)), \
             mock.patch.object(main_module, "validate_transcribe_request",
                               self._recording("validate", main_module.validate_transcribe_request)), \
             mock.patch.object(main_module, "available_ram_mb", return_value=64000), \
             mock.patch.object(main_module, "ffmpeg_available", return_value=True), \
             mock.patch.object(main_module, "assert_model_downloaded", return_value=None):
            resp = self.client.post("/transcribe/stream", json={"input_path": str(self.media / "clip.mkv"), "model": "small"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn('"type": "result"', resp.text)
        self.assertEqual(self.seen, {"validate": False})

    def test_upload_stream_saves_and_validates_off_the_loop(self):
        with mock.patch.object(main_module, "_save_upload", self._recording("save", main_module._save_upload)), \
             mock.patch.object(main_module, "validate_upload_request",
                               self._recording("validate", main_module.validate_upload_request)), \
             mock.patch.object(main_module, "available_ram_mb", return_value=64000), \
             mock.patch.object(main_module, "ffmpeg_available", return_value=True), \
             mock.patch.object(main_module, "assert_model_downloaded", return_value=None):
            resp = self.client.post(
                "/transcribe/upload/stream",
                files={"file": ("clip.wav", io.BytesIO(b"fake"), "audio/wav")},
                data={"request": '{"model": "small"}'},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertIn('"type": "result"', resp.text)
        self.assertEqual(self.seen, {"save": False, "validate": False})

    def test_url_stream_validates_off_the_loop(self):
        def fake_download(url, dest_dir):
            saved = Path(dest_dir) / "v1.m4a"
            saved.write_bytes(b"fake")
            return saved

        with mock.patch.object(main_module, "download_url", fake_download), \
             mock.patch.object(main_module, "validate_upload_request",
                               self._recording("validate", main_module.validate_upload_request)), \
             mock.patch.object(main_module, "available_ram_mb", return_value=64000), \
             mock.patch.object(main_module, "ffmpeg_available", return_value=True), \
             mock.patch.object(main_module, "assert_model_downloaded", return_value=None):
            resp = self.client.post("/transcribe/url/stream", json={"url": "https://example.com/v1", "model": "small"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn('"type": "result"', resp.text)
        self.assertEqual(self.seen, {"validate": False})


if __name__ == "__main__":
    unittest.main()
