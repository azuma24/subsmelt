import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.preflight import (
    DISK_FREE_UNKNOWN,
    disk_free_mb,
    evaluate_disk_safety,
    evaluate_model_safety,
    model_ram_requirements_mb,
)
from app.paths import output_path_for


class PreflightTests(unittest.TestCase):
    def test_model_ram_requirements_have_cpu_defaults(self):
        self.assertEqual(model_ram_requirements_mb("small"), {"required": 4096, "recommended": 8192})
        self.assertEqual(model_ram_requirements_mb("unknown"), {"required": 4096, "recommended": 8192})

    def test_evaluate_model_safety_reports_low_ram(self):
        result = evaluate_model_safety(model="medium", available_ram_mb=4096)
        self.assertFalse(result["safe"])
        self.assertEqual(result["code"], "insufficient_ram")
        self.assertEqual(result["suggested_model"], "small")

    def test_evaluate_model_safety_passes_safe_model(self):
        result = evaluate_model_safety(model="base", available_ram_mb=8192)
        self.assertTrue(result["safe"])
        self.assertEqual(result["code"], "ok")

    def test_disk_safety_requires_scratch_space(self):
        result = evaluate_disk_safety(input_size_mb=6000, available_disk_mb=3000)
        self.assertFalse(result["safe"])
        self.assertEqual(result["code"], "insufficient_disk")

    def test_disk_safety_fails_open_on_an_unknown_reading(self):
        # -1 means "could not measure" — blocking every transcription on that is
        # worse than proceeding, so it must not read as a full disk.
        result = evaluate_disk_safety(input_size_mb=6000, available_disk_mb=DISK_FREE_UNKNOWN)
        self.assertTrue(result["safe"])
        self.assertEqual(result["code"], "disk_unknown")

    def test_disk_free_mb_walks_up_to_an_existing_ancestor(self):
        # A media root on an offline mount used to raise FileNotFoundError here,
        # surfacing as an opaque 500 from /transcribe and /transcribe/preflight.
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "offline-mount" / "media" / "show"
            self.assertGreater(disk_free_mb(missing), 0)

    def test_disk_free_mb_reports_unknown_when_nothing_resolves(self):
        with mock.patch("app.preflight.shutil.disk_usage", side_effect=OSError("gone")):
            self.assertEqual(disk_free_mb(Path("/definitely/not/here")), DISK_FREE_UNKNOWN)

    def test_auto_language_output_attaches_to_video_stem(self):
        output = output_path_for(Path("/media/anime/Episode 01.mkv"), "auto", "srt")
        self.assertEqual(str(output), "/media/anime/Episode 01.srt")


if __name__ == "__main__":
    unittest.main()
