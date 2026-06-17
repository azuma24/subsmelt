import os
import tempfile
import unittest
from pathlib import Path

from app.model_cache import describe_model_cache


class ModelCacheTests(unittest.TestCase):
    def test_uses_hf_home_and_marks_uncached_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            info = describe_model_cache("small", 2048, env={"HF_HOME": tmp})
            self.assertEqual(info["cache_root"], tmp)
            self.assertFalse(info["cached"])
            self.assertIsNone(info["cache_path"])
            self.assertTrue(info["first_run_download_expected"])
            self.assertEqual(info["required_ram_mb"], 4096)
            self.assertEqual(info["recommended_ram_mb"], 8192)
            self.assertEqual(info["suggested_model"], "tiny")

    def test_detects_cached_model_in_huggingface_hub_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            model_dir = Path(tmp) / "hub" / "models--Systran--faster-whisper-small" / "snapshots" / "1234"
            model_dir.mkdir(parents=True)
            (model_dir / "model.bin").write_bytes(b"\0")
            info = describe_model_cache("small", 8192, env={"HF_HOME": tmp})
            self.assertEqual(info["cache_path"], str(model_dir))
            self.assertTrue(info["cached"])
            self.assertFalse(info["first_run_download_expected"])
            self.assertIsNone(info["suggested_model"])

    def test_weightless_snapshot_is_not_cached(self):
        # A snapshot dir without model.bin (partial/interrupted download) must NOT
        # be reported cached — otherwise it shows ✓ downloaded yet fails to load.
        with tempfile.TemporaryDirectory() as tmp:
            snap = Path(tmp) / "hub" / "models--Systran--faster-whisper-small" / "snapshots" / "1234"
            snap.mkdir(parents=True)  # no model.bin
            info = describe_model_cache("small", 8192, env={"HF_HOME": tmp})
            self.assertFalse(info["cached"])
            self.assertIsNone(info["cache_path"])

    def test_uses_xdg_cache_home_huggingface_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            info = describe_model_cache("base", 8192, env={"XDG_CACHE_HOME": tmp})
            self.assertEqual(info["cache_root"], str(Path(tmp) / "huggingface"))

    def test_local_model_path_is_reported_without_hub_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            local_model = Path(tmp) / "my-model"
            local_model.mkdir()
            info = describe_model_cache(str(local_model), 8192, env={})
            self.assertEqual(info["cache_root"], str(local_model.parent))
            self.assertEqual(info["cache_path"], str(local_model))
            self.assertTrue(info["cached"])


if __name__ == "__main__":
    unittest.main()
