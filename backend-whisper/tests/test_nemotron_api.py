"""The Nemotron engine through the HTTP API, with the fake nemo-speech binary."""

import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    from fastapi.testclient import TestClient

    import app.main as main_module
    import app.model_loader as model_loader
    import app.nemotron_runtime as nemotron_runtime
    import app.transcribe as transcribe
    from app import nemotron
    from app.engine import TranscriptionCancelled
    from app.schemas import TranscribeRequest
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TestClient = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None

from tests.nemotron_fixtures import can_exec_wrappers, seed_gguf, write_fake_binary, write_silent_wav

MODEL = "nemotron-3.5-asr"


def _copy_instead_of_ffmpeg(src: Path, dst: Path, is_cancelled=None) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, dst)
    return dst


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
@unittest.skipUnless(can_exec_wrappers(), "shell wrappers need a POSIX host")
class NemotronApiTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.binary = write_fake_binary(self.root)
        self.gguf = seed_gguf(self.root / "hf")
        self.wav = write_silent_wav(self.root / "clip.wav", 3.0)
        self._env = mock.patch.dict(
            os.environ, {"HF_HOME": str(self.root / "hf"), "SUBSMELT_NEMO_SPEECH": str(self.binary)}
        )
        self._env.start()
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        self._patches = [
            mock.patch.object(main_module, "USE_FAKE_TRANSCRIBE", False),
            mock.patch.object(main_module, "available_ram_mb", return_value=64000),
            mock.patch.object(main_module, "ffmpeg_available", return_value=True),
            mock.patch.object(transcribe, "extract_audio", _copy_instead_of_ffmpeg),
        ]
        for patch in self._patches:
            patch.start()
        model_loader.clear_model_cache()
        nemotron_runtime._version_of.cache_clear()
        self.client = TestClient(main_module.app)

    def tearDown(self):
        model_loader.clear_model_cache()
        for patch in self._patches:
            patch.stop()
        self._env.stop()
        self._tmp.cleanup()

    def _upload(self, path: str, request: dict):
        with self.wav.open("rb") as fh:
            return self.client.post(
                path,
                files={"file": ("clip.wav", io.BytesIO(fh.read()), "audio/wav")},
                data={"request": json.dumps(request)},
            )

    def test_upload_stream_returns_progress_then_a_literal_srt(self):
        resp = self._upload("/transcribe/upload/stream", {"model": MODEL, "language": "auto", "output_format": "srt"})
        self.assertEqual(resp.status_code, 200)
        lines = [json.loads(line) for line in resp.text.splitlines() if line.strip()]
        self.assertEqual(
            lines,
            [
                {"type": "progress", "processedSeconds": 3.0, "totalSeconds": 3.0, "pct": 100.0},
                {
                    "type": "result",
                    "ok": True,
                    "content": "1\n00:00:00,000 --> 00:00:02,900\nword0 word1 word2 word3 word4 word5\n",
                    "language": "en",
                    "segments": 1,
                    "duration_seconds": 3.0,
                    "chinese_script": None,
                },
            ],
        )

    def test_explicit_language_reaches_the_binary_and_comes_back_as_the_short_code(self):
        resp = self._upload("/transcribe/upload", {"model": MODEL, "language": "no", "output_format": "txt"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            resp.json(),
            {
                "ok": True,
                "content": "word0 word1 word2 word3 word4 word5\n",
                "language": "nb",
                "segments": 1,
                "duration_seconds": 3.0,
                "chinese_script": None,
            },
        )

    def test_health_reports_the_nemotron_descriptor_and_binary_version(self):
        caps = self.client.get("/health").json()["capabilities"]
        self.assertEqual(caps["nemoSpeech"], {"available": True, "version": "0.1.0"})
        self.assertEqual(caps["models"][-1], MODEL)
        entry = {m["id"]: m for m in caps["modelInfo"]}[MODEL]
        self.assertEqual((entry["engine"], entry["available"], entry["unavailableReason"]), ("nemotron", True, None))
        self.assertEqual(entry["supports"]["wordTimestamps"], True)
        self.assertEqual(entry["supports"]["beamSize"], False)

    def test_models_endpoint_carries_engine_fields_and_the_gguf_download(self):
        models = {m["id"]: m for m in self.client.get("/models").json()["models"]}
        self.assertEqual(
            {
                k: models[MODEL][k]
                for k in ("engine", "label", "downloaded", "available", "unavailableReason", "cachePath")
            },
            {
                "engine": "nemotron",
                "label": "Nemotron 3.5 ASR",
                "downloaded": True,
                "available": True,
                "unavailableReason": None,
                "cachePath": str(self.gguf.parent),
            },
        )
        self.assertEqual(models["small"]["languages"], "all")
        self.assertEqual(models["small"]["engine"], "whisper")

    def test_a_whisper_compute_type_does_not_block_nemotron(self):
        resp = self._upload(
            "/transcribe/upload", {"model": MODEL, "language": "en", "device": "cpu", "compute_type": "float16"}
        )
        self.assertEqual(resp.status_code, 200)

    def test_a_binary_that_cannot_run_marks_the_model_unavailable(self):
        broken = self.root / "broken" / "nemo-speech"
        broken.parent.mkdir()
        broken.write_bytes(b"\x7fELF not really a program")
        broken.chmod(0o755)
        with mock.patch.dict(os.environ, {"SUBSMELT_NEMO_SPEECH": str(broken)}):
            caps = self.client.get("/health").json()["capabilities"]
        entry = {m["id"]: m for m in caps["modelInfo"]}[MODEL]
        self.assertEqual(caps["nemoSpeech"], {"available": False, "version": None})
        self.assertEqual(
            (entry["available"], entry["unavailableReason"]),
            (False, f"nemo-speech runtime at {broken} does not run"),
        )

    def test_missing_binary_marks_the_model_unavailable_and_refuses_transcription(self):
        missing = str(self.root / "nowhere" / "nemo-speech")
        with mock.patch.dict(os.environ, {"SUBSMELT_NEMO_SPEECH": missing}):
            caps = self.client.get("/health").json()["capabilities"]
            entry = {m["id"]: m for m in caps["modelInfo"]}[MODEL]
            self.assertEqual(caps["nemoSpeech"], {"available": False, "version": None})
            self.assertEqual(
                (entry["available"], entry["unavailableReason"]),
                (False, f"nemo-speech runtime not found at {missing}"),
            )
            resp = self._upload("/transcribe/upload", {"model": MODEL, "language": "en"})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            resp.json()["detail"],
            {"code": "engine_unavailable", "message": f"nemo-speech runtime not found at {missing}", "model": MODEL},
        )

    def test_unsupported_language_is_a_400_before_the_stream_opens(self):
        resp = self._upload("/transcribe/upload/stream", {"model": MODEL, "language": "zh-TW"})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            resp.json()["detail"],
            {
                "code": "language_not_supported",
                "message": "Model 'nemotron-3.5-asr' does not support language 'zh-TW'. Use large-v3 or large-v3-turbo.",
                "model": MODEL,
                "language": "zh-TW",
            },
        )

    def test_missing_gguf_is_a_409(self):
        shutil.rmtree(self.root / "hf")
        resp = self._upload("/transcribe/upload", {"model": MODEL, "language": "en"})
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["detail"], {"code": "model_not_downloaded", "model": MODEL})

    def test_delete_removes_the_gguf_repo(self):
        resp = self.client.delete(f"/models/{MODEL}")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])
        self.assertFalse((self.root / "hf" / "hub" / "models--nvidia--nemotron-3.5-asr-streaming-0.6b").exists())
        self.assertFalse({m["id"]: m for m in self.client.get("/models").json()["models"]}[MODEL]["downloaded"])

    def test_cancel_mid_run_kills_the_child_and_removes_the_temp_dir(self):
        pidfile = self.root / "child.pid"
        request = TranscribeRequest(input_path=str(self.wav), model=MODEL, language="en", device="cpu")
        previous_tempdir = tempfile.tempdir
        tempfile.tempdir = str(self.root / "tmp")
        (self.root / "tmp").mkdir()
        try:
            with mock.patch.dict(
                os.environ, {"SUBSMELT_FAKE_NEMO_SLEEP": "30", "SUBSMELT_FAKE_NEMO_PIDFILE": str(pidfile)}
            ):
                events = nemotron.run(request, self.wav, is_cancelled=pidfile.exists, min_progress_interval=1.0)
                with self.assertRaises(TranscriptionCancelled):
                    list(events)
            pid = int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            self.assertEqual(sorted(p.name for p in (self.root / "tmp").iterdir()), [])
        finally:
            tempfile.tempdir = previous_tempdir


if __name__ == "__main__":
    unittest.main()
