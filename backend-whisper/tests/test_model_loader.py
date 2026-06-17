"""Loader regression tests.

The model downloader writes snapshots to ``cache_root_from_env()`` (it passes
``cache_dir=<root>`` to ``snapshot_download``). The loader MUST read from the
same root, otherwise faster-whisper defaults to ``<root>/hub`` and every
downloaded model fails to load with a bogus "weights not present" error.

faster-whisper is not installed in CI, so a fake ``faster_whisper`` module is
injected to capture the kwargs the loader passes to ``WhisperModel``.
"""

import sys
import types
import unittest
from unittest import mock

import app.model_loader as model_loader
from app.model_cache import cache_root_from_env


class GetWhisperModelTests(unittest.TestCase):
    def setUp(self):
        model_loader._MODEL_CACHE.clear()
        self._captured = {}

        captured = self._captured

        class _FakeWhisperModel:  # noqa: D401 - test double
            def __init__(self, model, **kwargs):
                captured["model"] = model
                captured["kwargs"] = kwargs

        fake_mod = types.ModuleType("faster_whisper")
        fake_mod.WhisperModel = _FakeWhisperModel
        self._patcher = mock.patch.dict(sys.modules, {"faster_whisper": fake_mod})
        self._patcher.start()
        # Bypass the CUDA/compute validation so the test runs on a CPU-only box.
        self._validate_patcher = mock.patch.object(
            model_loader, "validate_device_and_compute_type", lambda *a, **k: None
        )
        self._validate_patcher.start()

    def tearDown(self):
        self._validate_patcher.stop()
        self._patcher.stop()
        model_loader._MODEL_CACHE.clear()

    def test_loader_reads_from_downloader_cache_root(self):
        model_loader.get_whisper_model("tiny", "cpu", "int8")
        kwargs = self._captured["kwargs"]
        # The fix: download_root must match where the downloader wrote the model.
        self.assertEqual(kwargs.get("download_root"), str(cache_root_from_env()))
        self.assertTrue(kwargs.get("local_files_only"))

    def test_loader_caches_instance(self):
        first = model_loader.get_whisper_model("tiny", "cpu", "int8")
        second = model_loader.get_whisper_model("tiny", "cpu", "int8")
        self.assertIs(first, second)


if __name__ == "__main__":
    unittest.main()
