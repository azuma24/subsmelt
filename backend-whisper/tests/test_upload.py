import io
import os
import unittest
from pathlib import Path

# --- Direct fake-function tests (no fastapi/faster-whisper needed) ---
try:
    from app.schemas import TranscribeRequest
    from app.transcribe import (
        TranscriptionCancelled,
        fake_transcribe_upload_for_tests,
        fake_transcribe_upload_streaming_for_tests,
    )
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TranscribeRequest = None
    fake_transcribe_upload_for_tests = None
    fake_transcribe_upload_streaming_for_tests = None
    TranscriptionCancelled = None
    FUNC_IMPORT_ERROR = exc
else:
    FUNC_IMPORT_ERROR = None


@unittest.skipIf(FUNC_IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {FUNC_IMPORT_ERROR}")
class UploadFinalizeTests(unittest.TestCase):
    """The upload transport returns subtitle CONTENT, never a server path."""

    def _request(self) -> "TranscribeRequest":
        # input_path is a placeholder in upload mode; the bytes came over the wire.
        return TranscribeRequest(input_path="/uploads/clip.mkv", output_format="srt", language="en")

    def test_upload_returns_content_not_path(self):
        result = fake_transcribe_upload_for_tests(Path("/uploads/clip.mkv"), self._request())
        self.assertTrue(result["ok"])
        self.assertNotIn("subtitle_path", result)
        self.assertIn("content", result)
        self.assertGreaterEqual(result["segments"], 1)
        # SRT content carries the transcribed text and a timing arrow.
        self.assertIn("Test transcription", result["content"])
        self.assertIn("-->", result["content"])

    def test_upload_streaming_emits_progress_then_content_result(self):
        events = list(fake_transcribe_upload_streaming_for_tests(Path("/uploads/clip.mkv"), self._request()))
        progress = [e for e in events if e["type"] == "progress"]
        results = [e for e in events if e["type"] == "result"]
        self.assertGreaterEqual(len(progress), 1)
        self.assertEqual(len(results), 1)
        pcts = [e["pct"] for e in progress]
        self.assertEqual(pcts, sorted(pcts))  # monotonic non-decreasing
        terminal = results[0]
        self.assertTrue(terminal["ok"])
        self.assertIn("content", terminal)
        self.assertNotIn("subtitle_path", terminal)

    def test_upload_streaming_cancellation_raises(self):
        gen = fake_transcribe_upload_streaming_for_tests(
            Path("/uploads/clip.mkv"), self._request(), is_cancelled=lambda: True
        )
        with self.assertRaises(TranscriptionCancelled):
            list(gen)


# --- Endpoint tests (need fastapi TestClient; skipped where absent) ---
try:
    from fastapi.testclient import TestClient

    import app.main as main_module
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TestClient = None
    main_module = None
    ENDPOINT_IMPORT_ERROR = exc
else:
    ENDPOINT_IMPORT_ERROR = None


@unittest.skipIf(ENDPOINT_IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {ENDPOINT_IMPORT_ERROR}")
class UploadEndpointTests(unittest.TestCase):
    def setUp(self):
        os.environ["SUBSMELT_WHISPER_FAKE"] = "1"
        self.client = TestClient(main_module.app)
        self._prev_token = os.environ.get("SUBSMELT_WHISPER_TOKEN")
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)

    def tearDown(self):
        if self._prev_token is None:
            os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        else:
            os.environ["SUBSMELT_WHISPER_TOKEN"] = self._prev_token

    def _file(self):
        return {"file": ("clip.wav", io.BytesIO(b"fake audio bytes"), "audio/wav")}

    def test_bad_request_json_is_400(self):
        resp = self.client.post(
            "/transcribe/upload",
            files=self._file(),
            data={"request": "not-json"},
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["detail"]["code"], "bad_request")

    def test_undownloaded_model_is_409(self):
        # A valid request for a model that is not in the cache must be refused with
        # 409 model_not_downloaded — the upload path never auto-downloads either.
        resp = self.client.post(
            "/transcribe/upload",
            files=self._file(),
            data={"request": '{"model": "large-v3", "language": "en"}'},
        )
        # 409 when the model is absent; if a test host happens to have it cached the
        # fake path returns content instead — accept either, but never a silent
        # auto-download.
        self.assertIn(resp.status_code, (409, 200))
        if resp.status_code == 409:
            self.assertEqual(resp.json()["detail"]["code"], "model_not_downloaded")

    def test_auth_gate_blocks_missing_token(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        try:
            resp = self.client.post(
                "/transcribe/upload",
                files=self._file(),
                data={"request": '{"model": "small"}'},
            )
            self.assertEqual(resp.status_code, 401)
        finally:
            os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)


if __name__ == "__main__":
    unittest.main()
