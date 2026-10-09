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


def _hub_writing_weights(calls=None):
    def fake_dl(repo_id, cache_dir, tqdm_class, **kw):
        if calls is not None:
            calls.append({"repo_id": repo_id, **kw})
        snap = Path(cache_dir) / ("models--" + repo_id.replace("/", "--")) / "snapshots" / "abc"
        snap.mkdir(parents=True)
        weights = "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf" if "nemotron" in repo_id else "model.bin"
        (snap / weights).write_bytes(b"\0" * 2048)
        return str(snap)

    mod = types.ModuleType("huggingface_hub")
    mod.snapshot_download = fake_dl
    return mod


MIB = 1024 * 1024


def _hub_driving_hf_bars(sizes_mib, chunks_mib):
    """Drive ``tqdm_class`` the way huggingface_hub 1.x does: a transfer bar
    (network bytes), a reconstruct bar (bytes written) and a file counter, the
    two byte bars growing their totals as each file starts."""

    def fake_dl(repo_id, cache_dir, tqdm_class, **kw):
        transfer = tqdm_class(desc="Downloading bytes", total=0, initial=0, unit="B", unit_scale=True)
        written = tqdm_class(desc="Reconstructing (incomplete total...)", total=0, initial=0, unit="B", unit_scale=True)
        files = tqdm_class(desc=f"Fetching {len(sizes_mib)} files", total=len(sizes_mib))
        for size in sizes_mib:
            transfer.total += size * MIB
            written.total += size * MIB
        for chunk in chunks_mib:
            written.update(chunk * MIB)
            transfer.update(chunk * MIB)
        for _ in sizes_mib:
            files.update(1)
        for bar in (transfer, written, files):
            bar.close()
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

    def test_nemotron_downloads_only_the_gguf_and_flips_downloaded(self):
        calls = []
        self.assertFalse(self.mm.is_model_downloaded("nemotron-3.5-asr"))
        with mock.patch.dict(sys.modules, {"huggingface_hub": _hub_writing_weights(calls)}):
            events = list(self.mm.download_model_events("nemotron-3.5-asr"))
        self.assertEqual(
            calls,
            [
                {
                    "repo_id": "nvidia/nemotron-3.5-asr-streaming-0.6b",
                    "allow_patterns": ["nemotron-3.5-asr-streaming-0.6b.q8_0.gguf"],
                }
            ],
        )
        expected_path = str(
            Path(self._tmp.name) / "models--nvidia--nemotron-3.5-asr-streaming-0.6b" / "snapshots" / "abc"
        )
        self.assertEqual(
            events[-1], {"type": "result", "ok": True, "model": "nemotron-3.5-asr", "cachePath": expected_path}
        )
        self.assertTrue(self.mm.is_model_downloaded("nemotron-3.5-asr"))
        self.assertTrue(self.mm.delete_model("nemotron-3.5-asr")["ok"])
        self.assertFalse(self.mm.is_model_downloaded("nemotron-3.5-asr"))

    def test_whisper_downloads_pass_no_allow_patterns(self):
        calls = []
        with mock.patch.dict(sys.modules, {"huggingface_hub": _hub_writing_weights(calls)}):
            list(self.mm.download_model_events("tiny"))
        self.assertEqual(calls, [{"repo_id": "Systran/faster-whisper-tiny"}])

    def test_delete_removes_and_then_absent(self):
        with mock.patch.dict(sys.modules, {"huggingface_hub": _hub_writing_weights()}):
            list(self.mm.download_model_events("tiny"))
        result = self.mm.delete_model("tiny")
        self.assertTrue(result["ok"])
        self.assertGreaterEqual(result["freedMb"], 0)
        self.assertFalse(self.mm.is_model_downloaded("tiny"))

    def test_progress_reports_bytes_written_once_across_hf_bars(self):
        with mock.patch.dict(sys.modules, {"huggingface_hub": _hub_driving_hf_bars((64, 10), (37, 27, 10))}):
            events = list(self.mm.download_model_events("tiny"))
        self.assertEqual(
            [event for event in events if event["type"] == "progress"],
            [
                {"type": "progress", "pct": 50.0, "downloadedMb": 37.0, "totalMb": 74.0},
                {"type": "progress", "pct": 86.49, "downloadedMb": 64.0, "totalMb": 74.0},
                {"type": "progress", "pct": 100.0, "downloadedMb": 74.0, "totalMb": 74.0},
            ],
        )
        self.assertEqual(events[-1]["type"], "result")

    @unittest.skipIf(os.name == "nt", "symlinks need privileges on Windows")
    def test_sizes_count_symlinked_blobs_once(self):
        repo = Path(self._tmp.name) / "hub" / "models--Systran--faster-whisper-tiny"
        blob = repo / "blobs" / "sha256-abc"
        blob.parent.mkdir(parents=True)
        blob.write_bytes(b"\0" * 2 * MIB)
        snap = repo / "snapshots" / "deadbeef"
        snap.mkdir(parents=True)
        (snap / "model.bin").symlink_to(Path("..") / ".." / "blobs" / "sha256-abc")
        tiny = next(entry for entry in self.mm.describe_models() if entry["id"] == "tiny")
        self.assertEqual(tiny["sizeMb"], 2)
        self.assertEqual(self.mm.delete_model("tiny"), {"ok": True, "freedMb": 2})

    def test_delete_refuses_while_a_transcription_leases_the_model(self):
        import app.model_loader as model_loader

        fake_fw = types.ModuleType("faster_whisper")
        fake_fw.WhisperModel = lambda *a, **k: types.SimpleNamespace(model=None)
        with mock.patch.dict(sys.modules, {"huggingface_hub": _hub_writing_weights()}):
            list(self.mm.download_model_events("tiny"))
        weights = Path(self._tmp.name) / "models--Systran--faster-whisper-tiny" / "snapshots" / "abc" / "model.bin"
        model_loader.clear_model_cache()
        try:
            with mock.patch.dict(sys.modules, {"faster_whisper": fake_fw}), model_loader.lease("tiny", "cpu", "int8"):
                with self.assertRaises(self.mm.ModelInUseError) as ctx:
                    self.mm.delete_model("tiny")
                self.assertEqual(ctx.exception.model, "tiny")
                self.assertTrue(weights.exists())
            self.assertEqual(self.mm.delete_model("tiny")["ok"], True)
        finally:
            model_loader.clear_model_cache()
        self.assertFalse(weights.exists())

    def test_delete_leaves_weightless_dirs_that_share_the_model_name(self):
        with mock.patch.dict(sys.modules, {"huggingface_hub": _hub_writing_weights()}):
            list(self.mm.download_model_events("tiny"))
        root = Path(self._tmp.name)
        (root / "tiny").mkdir()
        (root / "tiny" / "notes.txt").write_text("not a model")
        (root / "faster-whisper-tiny").mkdir()
        self.mm.delete_model("tiny")
        self.assertFalse((root / "models--Systran--faster-whisper-tiny").exists())
        self.assertEqual(sorted(path.name for path in root.iterdir()), ["faster-whisper-tiny", "tiny"])


if __name__ == "__main__":
    unittest.main()
