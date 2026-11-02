"""Preflight endpoint behaviour when a resource reading is unavailable."""

import os
import tempfile
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


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
class PreflightUnknownReadingTests(unittest.TestCase):
    def setUp(self):
        os.environ["SUBSMELT_WHISPER_FAKE"] = "1"
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        self.client = TestClient(main_module.app)
        self._tmp = tempfile.TemporaryDirectory()
        self.media = Path(self._tmp.name)
        (self.media / "clip.mkv").write_bytes(b"x")

    def tearDown(self):
        self._tmp.cleanup()

    def _preflight(self, body: dict, *, ram: int = 64000, disk: int = 100000) -> dict:
        with (
            mock.patch.object(main_module, "MEDIA_ROOT", str(self.media)),
            mock.patch.object(main_module, "available_ram_mb", return_value=ram),
            mock.patch.object(main_module, "disk_free_mb", return_value=disk),
            mock.patch.object(main_module, "ffmpeg_available", return_value=True),
        ):
            resp = self.client.post(
                "/preflight", json={"input_path": str(self.media / "clip.mkv"), "model": "small", **body}
            )
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def test_unknown_ram_passes_as_a_warning_code(self):
        result = self._preflight({}, ram=0)
        self.assertEqual((result["ok"], result["safe"], result["code"]), (True, True, "ram_unknown"))

    def test_unknown_disk_passes_as_a_warning_code(self):
        result = self._preflight({}, disk=-1)
        self.assertEqual((result["ok"], result["code"]), (True, "disk_unknown"))

    def test_diarization_is_not_refused_when_ram_is_unknown(self):
        result = self._preflight({"advanced_options": {"speaker_diarization": True}}, ram=0)
        self.assertEqual((result["ok"], result["code"]), (True, "ram_unknown"))

    def test_diarization_headroom_still_refuses_on_a_real_shortfall(self):
        # small needs 4096 MB; 5000 MB is enough alone but not with the 2048 MB pyannote headroom.
        result = self._preflight({"advanced_options": {"speaker_diarization": True}}, ram=5000)
        self.assertEqual((result["ok"], result["code"]), (False, "insufficient_ram"))

    def test_a_real_blocker_wins_over_an_unknown_reading(self):
        result = self._preflight({"model": "large-v3"}, ram=4096, disk=-1)
        self.assertEqual((result["ok"], result["code"]), (False, "insufficient_ram"))


if __name__ == "__main__":
    unittest.main()
