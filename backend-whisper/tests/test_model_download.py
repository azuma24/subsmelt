"""Download/delete logic tests that do NOT require FastAPI.

Exercises download_model_events (progress → integrity-gated result, idempotency,
per-model serialization) and delete_model (hardened removal) directly, stubbing
tqdm + huggingface_hub so the suite runs even where those are absent.
"""

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


def _install_stubs():
    tq = types.ModuleType("tqdm")
    tqa = types.ModuleType("tqdm.auto")

    class _T:
        def __init__(self, *a, **k):
            self.n = 0
            self.total = k.get("total", 0)

        def update(self, n=1):
            self.n += n

        def close(self):
            pass

    tqa.tqdm = _T
    tq.auto = tqa
    return {"tqdm": tq, "tqdm.auto": tqa}


def _hub_writing_weights():
    def fake_dl(repo_id, cache_dir, tqdm_class, **kw):
        snap = Path(cache_dir) / ("models--" + repo_id.replace("/", "--")) / "snapshots" / "abc"
        snap.mkdir(parents=True)
        (snap / "model.bin").write_bytes(b"\0" * 2048)
        return str(snap)

    mod = types.ModuleType("huggingface_hub")
    mod.snapshot_download = fake_dl
    return mod


def _hub_writing_no_weights():
    def fake_dl(repo_id, cache_dir, tqdm_class, **kw):
        snap = Path(cache_dir) / ("models--" + repo_id.replace("/", "--")) / "snapshots" / "x"
        snap.mkdir(parents=True)  # no model.bin → incomplete
        return str(snap)

    mod = types.ModuleType("huggingface_hub")
    mod.snapshot_download = fake_dl
    return mod


class DownloadDeleteTests(unittest.TestCase):
    def setUp(self):
        self._prev_hf = os.environ.get("HF_HOME")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HF_HOME"] = self._tmp.name
        self._stubs = mock.patch.dict(sys.modules, _install_stubs())
        self._stubs.start()
        import app.model_manager as mm

        self.mm = mm

    def tearDown(self):
        self._stubs.stop()
        self._tmp.cleanup()
        if self._prev_hf is None:
            os.environ.pop("HF_HOME", None)
        else:
            os.environ["HF_HOME"] = self._prev_hf

    def test_download_then_result_and_idempotent(self):
        with mock.patch.dict(sys.modules, {"huggingface_hub": _hub_writing_weights()}):
            events = list(self.mm.download_model_events("tiny"))
        self.assertEqual(events[-1]["type"], "result")
        self.assertTrue(events[-1]["ok"])
        self.assertTrue(self.mm.is_model_downloaded("tiny"))
        # Second call short-circuits without re-downloading.
        again = list(self.mm.download_model_events("tiny"))
        self.assertTrue(again[-1].get("alreadyPresent"))

    def test_integrity_gate_rejects_weightless_snapshot(self):
        with mock.patch.dict(sys.modules, {"huggingface_hub": _hub_writing_no_weights()}):
            events = list(self.mm.download_model_events("base"))
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("model.bin", events[-1]["error"])
        # A weightless snapshot must NOT be reported as downloaded.
        self.assertFalse(self.mm.is_model_downloaded("base"))

    def test_delete_removes_and_then_absent(self):
        with mock.patch.dict(sys.modules, {"huggingface_hub": _hub_writing_weights()}):
            list(self.mm.download_model_events("tiny"))
        result = self.mm.delete_model("tiny")
        self.assertTrue(result["ok"])
        self.assertGreaterEqual(result["freedMb"], 0)
        self.assertFalse(self.mm.is_model_downloaded("tiny"))


if __name__ == "__main__":
    unittest.main()
