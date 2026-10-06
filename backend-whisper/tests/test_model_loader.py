"""Loader regression tests.

The loader MUST resolve a model to the exact on-disk snapshot directory that the
cache detector (describe_model_cache — the same code behind /models, /health and
assert_model_downloaded) found, and load WhisperModel from that path. This makes
load == detection regardless of HF cache layout (``<root>`` vs ``<root>/hub``) or
where the model was downloaded. Otherwise a model reported "downloaded" could
still fail to load.

faster-whisper is not installed in CI, so a fake ``faster_whisper`` module is
injected to capture the args the loader passes to ``WhisperModel``.
"""

import os
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import app.model_loader as model_loader
from app.engine import EngineUnavailableError
from app.model_cache import cache_root_from_env
from app.nemotron_runtime import NemotronHandle
from tests.nemotron_fixtures import seed_gguf


class GetWhisperModelTests(unittest.TestCase):
    def setUp(self):
        model_loader._MODEL_CACHE.clear()
        self._captured = {}
        captured = self._captured

        class _FakeCt2Model:
            def __init__(self):
                self.unload_calls = 0

            def unload_model(self, to_cpu=False):
                self.unload_calls += 1

        class _FakeWhisperModel:  # noqa: D401 - test double
            def __init__(self, model, **kwargs):
                captured["model"] = model
                captured["kwargs"] = kwargs
                self.model = _FakeCt2Model()

        fake_mod = types.ModuleType("faster_whisper")
        fake_mod.WhisperModel = _FakeWhisperModel
        self._patcher = mock.patch.dict(sys.modules, {"faster_whisper": fake_mod})
        self._patcher.start()
        # Bypass CUDA/compute validation so the test runs on a CPU-only box.
        self._validate_patcher = mock.patch.object(
            model_loader, "validate_device_and_compute_type", lambda *a, **k: None
        )
        self._validate_patcher.start()
        self._prev_hf_home = os.environ.get("HF_HOME")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HF_HOME"] = self._tmp.name

    def tearDown(self):
        if self._prev_hf_home is None:
            os.environ.pop("HF_HOME", None)
        else:
            os.environ["HF_HOME"] = self._prev_hf_home
        self._tmp.cleanup()
        self._validate_patcher.stop()
        self._patcher.stop()
        model_loader._MODEL_CACHE.clear()

    def _seed(self, model: str, *, layout: str) -> Path:
        """Create a fake snapshot for ``model`` under the hub or non-hub layout."""
        root = Path(self._tmp.name)
        base = root / "hub" if layout == "hub" else root
        snap = base / f"models--Systran--faster-whisper-{model}" / "snapshots" / "deadbeef"
        snap.mkdir(parents=True)
        (snap / "model.bin").write_bytes(b"\0")
        return snap

    def test_loads_from_resolved_snapshot_hub_layout(self):
        snap = self._seed("tiny", layout="hub")
        model_loader.get_whisper_model("tiny", "cpu", "int8")
        # The loader passes the resolved snapshot dir, not the bare model id, so a
        # hub-layout model loads even though download_root points at <root>.
        self.assertEqual(self._captured["model"], str(snap))
        self.assertTrue(self._captured["kwargs"].get("local_files_only"))

    def test_loads_from_resolved_snapshot_nonhub_layout(self):
        snap = self._seed("tiny", layout="nonhub")
        model_loader.get_whisper_model("tiny", "cpu", "int8")
        self.assertEqual(self._captured["model"], str(snap))

    def test_uncached_falls_back_to_raw_id_with_cache_root(self):
        # No snapshot seeded → not cached → pass the raw id so faster-whisper
        # raises a clean local-files-only error (mapped to 409 upstream).
        model_loader.get_whisper_model("tiny", "cpu", "int8")
        self.assertEqual(self._captured["model"], "tiny")
        self.assertEqual(
            self._captured["kwargs"].get("download_root"), str(cache_root_from_env())
        )
        self.assertTrue(self._captured["kwargs"].get("local_files_only"))

    def test_aligns_80_mel_extractor_to_encoder_n_mels(self):
        class _Filters:
            shape = (80, 201)

        class _FE:
            mel_filters = _Filters()
            sampling_rate = 16000
            hop_length = 160
            chunk_length = 30
            n_fft = 400

        class _CT2:
            n_mels = 128

        class _Whisper:
            model = _CT2()
            feature_extractor = _FE()

        created: dict = {}

        class _Extractor:
            def __init__(self, **kwargs):
                created.update(kwargs)

        fake_fe = types.ModuleType("faster_whisper.feature_extractor")
        fake_fe.FeatureExtractor = _Extractor
        whisper = _Whisper()
        with mock.patch.dict(sys.modules, {"faster_whisper.feature_extractor": fake_fe}):
            model_loader._align_feature_extractor(whisper)
        self.assertEqual(created.get("feature_size"), 128)
        self.assertIsInstance(whisper.feature_extractor, _Extractor)

    def test_align_is_noop_when_mel_bins_already_match(self):
        class _Filters:
            shape = (128, 201)

        class _FE:
            mel_filters = _Filters()

        class _Whisper:
            model = types.SimpleNamespace(n_mels=128)
            feature_extractor = _FE()

        w = _Whisper()
        fe = w.feature_extractor
        model_loader._align_feature_extractor(w)
        self.assertIs(w.feature_extractor, fe)

    def test_loading_a_different_model_evicts_the_resident_one(self):
        self._seed("tiny", layout="hub")
        self._seed("base", layout="hub")
        tiny = model_loader.get_whisper_model("tiny", "cpu", "int8")
        base = model_loader.get_whisper_model("base", "cpu", "int8")
        self.assertEqual(list(model_loader._MODEL_CACHE.values()), [base])
        self.assertEqual(tiny.model.unload_calls, 1)
        self.assertEqual(base.model.unload_calls, 0)

    def test_eviction_defers_unload_until_the_lease_ends(self):
        self._seed("tiny", layout="hub")
        self._seed("base", layout="hub")
        with model_loader.lease("tiny", "cpu", "int8") as tiny:
            base = model_loader.get_whisper_model("base", "cpu", "int8")
            # Evicted from the cache, but a transcription still holds it.
            self.assertEqual(list(model_loader._MODEL_CACHE.values()), [base])
            self.assertEqual(tiny.model.unload_calls, 0)
        self.assertEqual(tiny.model.unload_calls, 1)

    def test_competing_load_during_lease_acquisition_cannot_unload_the_leased_model(self):
        self._seed("tiny", layout="hub")
        self._seed("base", layout="hub")
        tiny = model_loader.get_whisper_model("tiny", "cpu", "int8")
        competitor = threading.Thread(target=model_loader.get_whisper_model, args=("base", "cpu", "int8"))

        class CacheReadTriggersCompetingLoad(dict):
            """Fires a competing load right after the lease's cache read, the window
            where the old lock-free fast path let eviction unload a model that was
            about to be handed out."""
            fired = False

            def get(self, key, default=None):
                value = dict.get(self, key, default)
                if key[0] == "tiny" and value is not None and not self.fired:
                    self.fired = True
                    competitor.start()
                    time.sleep(0.2)
                return value

        with mock.patch.object(model_loader, "_MODEL_CACHE", CacheReadTriggersCompetingLoad(model_loader._MODEL_CACHE)):
            with model_loader.lease("tiny", "cpu", "int8") as leased:
                competitor.join(2.0)
                self.assertIs(leased, tiny)
                self.assertEqual(tiny.model.unload_calls, 0)
        self.assertEqual(tiny.model.unload_calls, 1)

    def test_reloading_an_evicted_but_leased_model_reuses_it(self):
        self._seed("tiny", layout="hub")
        self._seed("base", layout="hub")
        with model_loader.lease("tiny", "cpu", "int8") as tiny:
            model_loader.get_whisper_model("base", "cpu", "int8")
            again = model_loader.get_whisper_model("tiny", "cpu", "int8")
            self.assertIs(again, tiny)
            self.assertEqual(list(model_loader._MODEL_CACHE.values()), [tiny])
        self.assertEqual(tiny.model.unload_calls, 0)

    def test_unload_model_releases_the_resident_instance_by_id(self):
        self._seed("tiny", layout="hub")
        tiny = model_loader.get_whisper_model("tiny", "cpu", "int8")
        self.assertTrue(model_loader.unload_model("Tiny"))
        self.assertEqual(model_loader._MODEL_CACHE, {})
        self.assertEqual(tiny.model.unload_calls, 1)
        self.assertFalse(model_loader.unload_model("tiny"))

    def test_cache_key_normalizes_model_id_case(self):
        self._seed("tiny", layout="hub")
        first = model_loader.get_whisper_model("tiny", "cpu", "int8")
        # "Tiny" must hit the same cached instance, not load a duplicate.
        second = model_loader.get_whisper_model("Tiny", "cpu", "int8")
        self.assertIs(first, second)

    def test_leasing_nemotron_evicts_the_resident_whisper_model(self):
        self._seed("tiny", layout="hub")
        gguf = seed_gguf(Path(self._tmp.name))
        tiny = model_loader.get_whisper_model("tiny", "cpu", "int8")
        with mock.patch.dict(os.environ, {"SUBSMELT_NEMO_SPEECH": sys.executable}):
            with model_loader.lease("nemotron-3.5-asr", "cpu", "int8") as handle:
                self.assertEqual(handle, NemotronHandle(binary=Path(sys.executable), gguf=gguf))
                self.assertEqual(list(model_loader._MODEL_CACHE.values()), [handle])
                self.assertEqual(tiny.model.unload_calls, 1)

    def test_loading_whisper_evicts_the_resident_nemotron_handle(self):
        self._seed("tiny", layout="hub")
        seed_gguf(Path(self._tmp.name))
        with mock.patch.dict(os.environ, {"SUBSMELT_NEMO_SPEECH": sys.executable}):
            model_loader.get_whisper_model("nemotron-3.5-asr", "cpu", "int8")
            tiny = model_loader.get_whisper_model("tiny", "cpu", "int8")
        self.assertEqual(list(model_loader._MODEL_CACHE.values()), [tiny])
        self.assertTrue(model_loader.unload_model("nemotron-3.5-asr") is False)

    def test_unload_model_releases_a_resident_nemotron_handle(self):
        seed_gguf(Path(self._tmp.name))
        with mock.patch.dict(os.environ, {"SUBSMELT_NEMO_SPEECH": sys.executable}):
            model_loader.get_whisper_model("nemotron-3.5-asr", "cpu", "int8")
        self.assertTrue(model_loader.unload_model("Nemotron-3.5-ASR"))
        self.assertEqual(model_loader._MODEL_CACHE, {})

    def test_nemotron_without_gguf_is_weights_missing(self):
        with mock.patch.dict(os.environ, {"SUBSMELT_NEMO_SPEECH": sys.executable}):
            with self.assertRaises(model_loader.ModelWeightsMissingError) as ctx:
                model_loader.get_whisper_model("nemotron-3.5-asr", "cpu", "int8")
        self.assertEqual(ctx.exception.model, "nemotron-3.5-asr")

    def test_nemotron_without_binary_is_engine_unavailable(self):
        seed_gguf(Path(self._tmp.name))
        with mock.patch.dict(os.environ, {"SUBSMELT_NEMO_SPEECH": "/nonexistent/nemo-speech"}):
            with self.assertRaises(EngineUnavailableError) as ctx:
                model_loader.get_whisper_model("nemotron-3.5-asr", "cpu", "int8")
        self.assertEqual(str(ctx.exception), "nemo-speech runtime not found at /nonexistent/nemo-speech")


if __name__ == "__main__":
    unittest.main()
