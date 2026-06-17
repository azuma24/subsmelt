import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

try:
    from fastapi.testclient import TestClient

    import app.main as main_module
    import app.model_manager as model_manager
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TestClient = None
    main_module = None
    model_manager = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
class ModelManagerEndpointTests(unittest.TestCase):
    """Whisper model-manager API.

    Everything is exercised with a fake HF cache directory (no network, no GPU).
    ``HF_HOME`` points at a temp dir so describe_model_cache / delete_model see a
    controllable cache layout, and huggingface_hub is mocked for the download
    path.
    """

    def setUp(self):
        os.environ["SUBSMELT_WHISPER_FAKE"] = "1"
        self._prev_hf_home = os.environ.get("HF_HOME")
        self._prev_token = os.environ.get("SUBSMELT_WHISPER_TOKEN")
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)  # auth disabled for these tests
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HF_HOME"] = self._tmp.name
        self.client = TestClient(main_module.app)

    def tearDown(self):
        self._tmp.cleanup()
        for key, prev in (("HF_HOME", self._prev_hf_home), ("SUBSMELT_WHISPER_TOKEN", self._prev_token)):
            if prev is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = prev

    # --- helpers -----------------------------------------------------------

    def _seed_cached_model(self, model: str, *, size_bytes: int = 1024 * 1024) -> Path:
        """Create a fake HF hub snapshot dir for ``model`` and return its path."""
        snap = (
            Path(self._tmp.name)
            / "hub"
            / f"models--Systran--faster-whisper-{model}"
            / "snapshots"
            / "deadbeef"
        )
        snap.mkdir(parents=True)
        (snap / "model.bin").write_bytes(b"\0" * size_bytes)
        return snap

    # --- GET /models -------------------------------------------------------

    def test_list_models_shape_and_downloaded_flags(self):
        self._seed_cached_model("small")
        resp = self.client.get("/models")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("models", body)
        models = {m["id"]: m for m in body["models"]}
        # All advertised models present (derived, so this never drifts from the set).
        self.assertEqual(set(models), set(model_manager.ADVERTISED_MODELS))
        # Shape of each entry.
        for m in body["models"]:
            for key in ("id", "downloaded", "sizeMb", "requiredRamMb", "requiredVramMb", "cachePath"):
                self.assertIn(key, m)
            self.assertIsInstance(m["requiredRamMb"], int)
            self.assertIsInstance(m["requiredVramMb"], int)

        # Downloaded model: flag true, cachePath set, sizeMb = real on-disk size.
        small = models["small"]
        self.assertTrue(small["downloaded"])
        self.assertIsNotNone(small["cachePath"])
        self.assertEqual(small["sizeMb"], 1)  # 1 MiB file

        # Undownloaded model: flag false, cachePath None, sizeMb = approx estimate.
        tiny = models["tiny"]
        self.assertFalse(tiny["downloaded"])
        self.assertIsNone(tiny["cachePath"])
        self.assertEqual(tiny["sizeMb"], model_manager.APPROX_MODEL_SIZE_MB["tiny"])

    # --- POST /models/download --------------------------------------------

    def test_download_rejects_unknown_model(self):
        resp = self.client.post("/models/download", json={"model": "ginormous"})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["detail"]["code"], "unknown_model")

    def test_download_streams_progress_then_result(self):
        # Fake huggingface_hub.snapshot_download: drive the supplied tqdm_class to
        # emit progress, then create the snapshot dir so the model is "present".
        target_snap = (
            Path(self._tmp.name)
            / "hub"
            / "models--Systran--faster-whisper-tiny"
            / "snapshots"
            / "abc123"
        )

        def fake_snapshot_download(repo_id, cache_dir, tqdm_class, **kwargs):
            self.assertEqual(repo_id, "Systran/faster-whisper-tiny")
            bar = tqdm_class(total=100, unit="B")
            bar.update(50)
            bar.update(50)
            bar.close()
            target_snap.mkdir(parents=True)
            (target_snap / "model.bin").write_bytes(b"\0" * 1024)
            return str(target_snap)

        fake_hub = types.ModuleType("huggingface_hub")
        fake_hub.snapshot_download = fake_snapshot_download
        fake_tqdm = types.ModuleType("tqdm")
        fake_tqdm_auto = types.ModuleType("tqdm.auto")
        fake_tqdm_auto.tqdm = _FakeTqdm
        fake_tqdm.auto = fake_tqdm_auto

        with mock.patch.dict(
            sys.modules,
            {"huggingface_hub": fake_hub, "tqdm": fake_tqdm, "tqdm.auto": fake_tqdm_auto},
        ):
            resp = self.client.post("/models/download", json={"model": "tiny"})
            self.assertEqual(resp.status_code, 200)
            lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]

        types_seen = [l["type"] for l in lines]
        self.assertIn("progress", types_seen)
        self.assertEqual(types_seen[-1], "result")
        result = lines[-1]
        self.assertTrue(result["ok"])
        self.assertEqual(result["model"], "tiny")
        self.assertIsNotNone(result["cachePath"])
        # Progress lines carry the documented shape.
        for p in (l for l in lines if l["type"] == "progress"):
            for key in ("pct", "downloadedMb", "totalMb"):
                self.assertIn(key, p)

    def test_download_idempotent_when_already_present(self):
        self._seed_cached_model("base")
        # Even with no huggingface_hub installed, an already-present model must
        # short-circuit to an immediate result.
        resp = self.client.post("/models/download", json={"model": "base"})
        self.assertEqual(resp.status_code, 200)
        lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["type"], "result")
        self.assertTrue(lines[0]["ok"])
        self.assertTrue(lines[0].get("alreadyPresent"))

    # --- DELETE /models/{model} -------------------------------------------

    def test_delete_removes_snapshot_and_reports_freed(self):
        self._seed_cached_model("small", size_bytes=2 * 1024 * 1024)
        repo_dir = Path(self._tmp.name) / "hub" / "models--Systran--faster-whisper-small"
        self.assertTrue(repo_dir.exists())

        resp = self.client.delete("/models/small")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertGreaterEqual(body["freedMb"], 2)
        self.assertFalse(repo_dir.exists())

    def test_delete_404_when_not_present(self):
        resp = self.client.delete("/models/medium")
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.json()["detail"]["code"], "model_not_downloaded")

    def test_delete_400_unknown_model(self):
        resp = self.client.delete("/models/bogus")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["detail"]["code"], "unknown_model")

    # --- transcribe refuses undownloaded model ----------------------------

    def test_transcribe_undownloaded_model_returns_409(self):
        # medium is NOT seeded into the cache → must be refused, never downloaded.
        with tempfile.TemporaryDirectory() as media:
            media_file = Path(media) / "clip.mkv"
            media_file.write_bytes(b"fake media")
            with mock.patch.object(main_module, "MEDIA_ROOT", media):
                resp = self.client.post(
                    "/transcribe",
                    json={"input_path": str(media_file), "model": "medium", "allow_unsafe": True},
                )
        self.assertEqual(resp.status_code, 409)
        detail = resp.json()["detail"]
        self.assertEqual(detail["code"], "model_not_downloaded")
        self.assertEqual(detail["model"], "medium")

    def test_transcribe_downloaded_model_passes_409_gate(self):
        # A present model must NOT be refused with 409 (it proceeds to fake xcribe).
        self._seed_cached_model("small")
        with tempfile.TemporaryDirectory() as media:
            media_file = Path(media) / "clip.mkv"
            media_file.write_bytes(b"fake media")
            with mock.patch.object(main_module, "MEDIA_ROOT", media):
                resp = self.client.post(
                    "/transcribe",
                    json={"input_path": str(media_file), "model": "small", "allow_unsafe": True},
                )
        self.assertNotEqual(resp.status_code, 409)


class _FakeTqdm:
    """Minimal tqdm stand-in: tracks n/total and supports update/close.

    Lives at module scope so it is importable as ``tqdm.auto.tqdm`` and can be
    subclassed by ``model_manager._make_progress_tqdm`` exactly like the real one.
    """

    def __init__(self, *args, total=0, **kwargs):
        self.n = 0
        self.total = total or 0

    def update(self, n=1):
        self.n += n
        return True

    def close(self):
        return None


if __name__ == "__main__":
    unittest.main()
