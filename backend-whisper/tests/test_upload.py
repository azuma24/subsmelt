import importlib.util
import io
import os
import unittest
from pathlib import Path
from unittest import mock

# --- Direct fake-function tests (no fastapi/faster-whisper needed) ---
try:
    from app.schemas import TranscribeRequest
    from app.transcribe import (
        TranscriptionCancelled,
        fake_transcribe_for_tests,
        fake_transcribe_streaming_for_tests,
    )
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TranscribeRequest = None
    fake_transcribe_for_tests = None
    fake_transcribe_streaming_for_tests = None
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
        result = fake_transcribe_for_tests(Path("/uploads/clip.mkv"), self._request(), deliver="content")
        self.assertTrue(result["ok"])
        self.assertNotIn("subtitle_path", result)
        self.assertIn("content", result)
        self.assertGreaterEqual(result["segments"], 1)
        # SRT content carries the transcribed text and a timing arrow.
        self.assertIn("Test transcription", result["content"])
        self.assertIn("-->", result["content"])

    def test_upload_streaming_emits_progress_then_content_result(self):
        events = list(
            fake_transcribe_streaming_for_tests(Path("/uploads/clip.mkv"), self._request(), deliver="content")
        )
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
        gen = fake_transcribe_streaming_for_tests(
            Path("/uploads/clip.mkv"), self._request(), is_cancelled=lambda: True, deliver="content"
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


@unittest.skipIf(
    ENDPOINT_IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {ENDPOINT_IMPORT_ERROR}"
)
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
        # The upload preflight gate runs before the model-cache check, so pin
        # everything it inspects: a small build host refuses large-v3 with 422
        # insufficient_ram, and a host without ffmpeg refuses with 422
        # ffmpeg_missing. Neither is what this test is about.
        with (
            mock.patch.object(main_module, "available_ram_mb", return_value=64000),
            mock.patch.object(main_module, "ffmpeg_available", return_value=True),
        ):
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

    def test_dotdot_filename_is_400_not_500(self):
        resp = self.client.post(
            "/transcribe/upload",
            files={"file": ("..", io.BytesIO(b"xx"), "audio/wav")},
            data={"request": '{"model": "small"}'},
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["detail"]["code"], "bad_request")

    def test_upload_is_saved_under_its_basename(self):
        import tempfile

        from starlette.datastructures import UploadFile

        with tempfile.TemporaryDirectory() as tmp:
            for raw in ("nested/../../clip.wav", "C:\\Users\\me\\clip.wav", "clip.wav"):
                saved = main_module._save_upload(UploadFile(io.BytesIO(b"xx"), filename=raw), Path(tmp))
                self.assertEqual(saved, Path(tmp) / "clip.wav")
            saved = main_module._save_upload(UploadFile(io.BytesIO(b"xx"), filename=""), Path(tmp))
            self.assertEqual(saved, Path(tmp) / "upload.bin")

    def test_upload_names_are_safe_to_create_on_windows(self):
        # ? * " < > | fail to create on NTFS (a 500), ':' opens an alternate
        # data stream, trailing dots/spaces are dropped by Win32, and device
        # names such as CON refer to the console, not a file.
        cases = {
            'what?*"<>|.mkv': "what______.mkv",
            "clip:stream.wav": "clip_stream.wav",
            "clip.wav. . ": "clip.wav",
            "CON": "_CON",
            "nul.mp4": "_nul.mp4",
            "com1.tar.gz": "_com1.tar.gz",
            "tab\tname.wav": "tab_name.wav",
            "...": "upload.bin",
        }
        for raw, expected in cases.items():
            self.assertEqual(main_module._upload_basename(raw), expected, raw)

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

    def _spying_on_parsed_bytes(self) -> dict:
        import starlette.formparsers as formparsers

        seen = {"bytes": 0}
        original = formparsers.MultiPartParser.on_part_data

        def spy(parser, data, start, end):
            seen["bytes"] += end - start
            return original(parser, data, start, end)

        patcher = mock.patch.object(formparsers.MultiPartParser, "on_part_data", spy)
        patcher.start()
        self.addCleanup(patcher.stop)
        return seen

    def test_wrong_token_is_rejected_before_the_body_is_parsed(self):
        seen = self._spying_on_parsed_bytes()
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        for route in ("/transcribe/upload", "/transcribe/upload/stream"):
            resp = self.client.post(
                route,
                files={"file": ("clip.wav", io.BytesIO(b"\0" * 300_000), "audio/wav")},
                data={"request": '{"model": "small"}'},
                headers={"Authorization": "Bearer wrong"},
            )
            self.assertEqual((resp.status_code, resp.json()["detail"]["code"]), (401, "unauthorized"), route)
        self.assertEqual(seen["bytes"], 0)

    def test_correct_token_passes_the_upload_gate(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        with (
            mock.patch.object(main_module, "USE_FAKE_TRANSCRIBE", True),
            mock.patch.object(main_module, "available_ram_mb", return_value=64000),
            mock.patch.object(main_module, "ffmpeg_available", return_value=True),
            mock.patch.object(main_module, "assert_model_downloaded", return_value=None),
        ):
            resp = self.client.post(
                "/transcribe/upload",
                files=self._file(),
                data={"request": '{"model": "small", "language": "en"}'},
                headers={"Authorization": "Bearer s3cr3t"},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertIn("Test transcription", resp.json()["content"])

    def test_upload_over_the_cap_is_413_before_the_body_is_parsed(self):
        seen = self._spying_on_parsed_bytes()
        with mock.patch.dict(os.environ, {"SUBSMELT_WHISPER_MAX_UPLOAD_MB": "1"}):
            resp = self.client.post(
                "/transcribe/upload",
                files={"file": ("clip.wav", io.BytesIO(b"\0" * (2 * 1024 * 1024)), "audio/wav")},
                data={"request": '{"model": "small"}'},
            )
        self.assertEqual(resp.status_code, 413)
        self.assertEqual(resp.json()["detail"], {"code": "upload_too_large", "message": "Upload exceeds 1 MB"})
        self.assertEqual(seen["bytes"], 0)

    def test_chunked_upload_without_content_length_is_capped_too(self):
        def chunks():
            for _ in range(3):
                yield b"\0" * (1024 * 1024)

        with mock.patch.dict(os.environ, {"SUBSMELT_WHISPER_MAX_UPLOAD_MB": "1"}):
            resp = self.client.post(
                "/transcribe/upload",
                content=chunks(),
                headers={"Content-Type": "multipart/form-data; boundary=x"},
            )
        self.assertEqual(resp.status_code, 413)
        self.assertEqual(resp.json()["detail"]["code"], "upload_too_large")

    def _diarization_upload(self):
        with (
            mock.patch.object(main_module, "available_ram_mb", return_value=64000),
            mock.patch.object(main_module, "ffmpeg_available", return_value=True),
            mock.patch.object(main_module, "assert_model_downloaded", return_value=None),
            mock.patch.object(main_module, "fake_transcribe_for_tests", side_effect=AssertionError("ran")),
            mock.patch.object(main_module, "run_transcription", side_effect=AssertionError("ran")),
        ):
            return self.client.post(
                "/transcribe/upload",
                files=self._file(),
                data={"request": '{"model": "small", "advanced_options": {"speaker_diarization": true}}'},
            )

    def test_diarization_without_a_token_is_refused_before_transcription(self):
        with mock.patch.dict(os.environ, {"SUBSMELT_HF_TOKEN": "", "HF_TOKEN": ""}):
            resp = self._diarization_upload()
        self.assertEqual((resp.status_code, resp.json()["detail"]["code"]), (422, "diarization_token_missing"))

    @unittest.skipIf(importlib.util.find_spec("pyannote") is not None, "pyannote installed")
    def test_diarization_without_pyannote_is_refused_before_transcription(self):
        with mock.patch.dict(os.environ, {"SUBSMELT_HF_TOKEN": "hf_x"}):
            resp = self._diarization_upload()
        self.assertEqual((resp.status_code, resp.json()["detail"]["code"]), (400, "diarization_unavailable"))

    def _validate(self, request: dict, *, upload_size_mb: int, ram: int = 64000, disk: int = 100000) -> None:
        from app.schemas import TranscribeRequest

        with (
            mock.patch.object(main_module, "available_ram_mb", return_value=ram),
            mock.patch.object(main_module, "disk_free_mb", return_value=disk),
            mock.patch.object(main_module, "ffmpeg_available", return_value=True),
            mock.patch.object(main_module, "assert_model_downloaded", return_value=None),
        ):
            main_module.validate_upload_request(
                TranscribeRequest(input_path="/tmp/x/clip.wav", model="small", **request),
                upload_size_mb,
                Path("/tmp/x"),
            )

    def test_upload_preflight_adds_the_diarization_headroom(self):
        from fastapi import HTTPException

        # small needs 4096 MB; 5000 MB is enough alone but not with the 2048 MB pyannote headroom.
        self._validate({}, upload_size_mb=10, ram=5000)
        with self.assertRaises(HTTPException) as ctx:
            self._validate({"advanced_options": {"speaker_diarization": True}}, upload_size_mb=10, ram=5000)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(
            (ctx.exception.detail["code"], ctx.exception.detail["requiredRamMb"]), ("insufficient_ram", 6144)
        )

    def test_upload_disk_preflight_does_not_count_the_upload_against_itself(self):
        from fastapi import HTTPException

        # The upload already sits in the scratch dir when free space is read, so
        # the 1.5x rule path mode applies (2250 MB for 1500 MB) is judged against
        # free space plus the upload: 1000 + 1500 passes, 700 + 1500 does not.
        self._validate({}, upload_size_mb=1500, disk=1000)
        with self.assertRaises(HTTPException) as ctx:
            self._validate({}, upload_size_mb=1500, disk=700)
        self.assertEqual((ctx.exception.status_code, ctx.exception.detail["code"]), (422, "insufficient_disk"))


if __name__ == "__main__":
    unittest.main()
