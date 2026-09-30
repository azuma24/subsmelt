"""Streaming endpoints: pre-stream work stays off the event loop, and a client
that disconnects mid-stream never leaks the temp media or crashes the worker."""

import asyncio
import io
import os
import tempfile
import threading
import time
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


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
class DisconnectMidStreamTests(unittest.TestCase):
    def test_disconnect_mid_step_stops_the_worker_and_runs_cleanup(self):
        from app.transcribe import TranscriptionCancelled

        cleaned = threading.Event()
        seen: dict = {}

        def slow_generator(is_cancelled):
            try:
                for step in range(40):
                    time.sleep(0.05)  # one blocking decode step
                    if is_cancelled():
                        seen["cancelled_at"] = step
                        raise TranscriptionCancelled("cancelled")
                    yield {"type": "progress", "step": step}
            finally:
                seen["generator_closed"] = True

        async def client_that_leaves_after_first_line():
            cancel_event = asyncio.Event()
            stream = main_module._ndjson_stream(
                slow_generator(cancel_event.is_set), cancel_event, cleanup=cleaned.set
            )
            first = await stream.__anext__()
            await stream.aclose()  # the client is gone while a step is executing
            return first

        first = asyncio.run(client_that_leaves_after_first_line())
        self.assertEqual(first, b'{"type": "progress", "step": 0}\n')
        self.assertTrue(cleaned.wait(2.0), "cleanup never ran after the disconnect")
        self.assertTrue(seen["generator_closed"])
        self.assertLess(seen["cancelled_at"], 5)

    def test_worker_error_is_sent_as_a_terminal_error_line_then_cleanup(self):
        cleaned = threading.Event()

        def failing_generator():
            yield {"type": "progress"}
            raise RuntimeError("decoder exploded")

        async def read_all():
            cancel_event = asyncio.Event()
            stream = main_module._ndjson_stream(failing_generator(), cancel_event, cleanup=cleaned.set)
            return [line async for line in stream]

        lines = asyncio.run(read_all())
        self.assertEqual(lines, [b'{"type": "progress"}\n', b'{"type": "error", "error": "decoder exploded"}\n'])
        self.assertTrue(cleaned.wait(2.0))

    def test_cleanup_failure_is_logged_and_the_stream_still_ends(self):
        def one_line():
            yield {"type": "progress"}

        def locked_cleanup():
            raise PermissionError("upload.wav is in use")

        async def read_all():
            stream = main_module._ndjson_stream(one_line(), asyncio.Event(), cleanup=locked_cleanup)
            return [line async for line in stream]

        with self.assertLogs("app.main", level="ERROR") as logs:
            lines = asyncio.run(read_all())
        self.assertEqual(lines, [b'{"type": "progress"}\n'])
        self.assertIn("upload.wav is in use", "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
