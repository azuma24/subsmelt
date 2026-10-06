import unittest
from unittest import mock

from app import provision


EXPECTED_CHECK_IDS = [
    "os",
    "cpu",
    "ram",
    "gpu",
    "nvidia_driver",
    "cuda_runtime",
    "disk",
    "vcredist",
    "ffmpeg",
    "port",
]


class ProvisionDetectTests(unittest.TestCase):
    def test_detect_returns_all_expected_check_ids_and_bool_ready(self):
        report = provision.detect()
        self.assertIn("ready", report)
        self.assertIsInstance(report["ready"], bool)
        self.assertIn("summary", report)
        self.assertIsInstance(report["summary"], str)
        ids = [c["id"] for c in report["checks"]]
        self.assertEqual(ids, EXPECTED_CHECK_IDS)
        # Every check has the required shape.
        for check in report["checks"]:
            self.assertIn(check["status"], {"ok", "warn", "fail", "unknown", "info", "na"})
            self.assertIn("label", check)
            self.assertIn("detail", check)

    def test_no_gpu_reflects_absence_and_cuda_is_info_not_fail(self):
        with mock.patch.object(provision, "gpu_info", return_value=[]), \
             mock.patch.object(provision, "cuda_device_count", return_value=0):
            report = provision.detect()
        by_id = {c["id"]: c for c in report["checks"]}
        # GPU absence reflected (info, CPU-only).
        self.assertEqual(by_id["gpu"]["status"], "info")
        self.assertIn("CPU", by_id["gpu"]["detail"])
        # CUDA runtime is info (CPU mode), NOT fail.
        self.assertEqual(by_id["cuda_runtime"]["status"], "info")
        self.assertNotEqual(by_id["cuda_runtime"]["status"], "fail")
        # GPU/CUDA/driver never block readiness on a CPU box.
        self.assertNotIn("gpu", provision._READINESS_BLOCKERS)
        self.assertNotIn("cuda_runtime", provision._READINESS_BLOCKERS)
        self.assertNotIn("nvidia_driver", provision._READINESS_BLOCKERS)

    def test_gpu_present_but_old_driver_emits_fix_descriptor_with_url(self):
        fake_gpu = [{"name": "GeForce RTX 4090", "total_vram_mb": 24576, "free_vram_mb": 20000}]
        with mock.patch.object(provision, "gpu_info", return_value=fake_gpu), \
             mock.patch.object(provision, "_parse_driver_version", return_value="400.00"):
            check = provision._check_nvidia_driver()
        self.assertEqual(check["status"], "fail")
        self.assertIn("fix", check)
        self.assertEqual(check["fix"]["action"], "download_driver")
        self.assertEqual(check["fix"]["url"], provision.NVIDIA_DRIVER_URL)
        self.assertIn("RTX 4090", check["fix"]["label"])

    def test_gpu_present_with_new_driver_is_ok_no_fix(self):
        fake_gpu = [{"name": "RTX 4090", "total_vram_mb": 24576, "free_vram_mb": 20000}]
        with mock.patch.object(provision, "gpu_info", return_value=fake_gpu), \
             mock.patch.object(provision, "_parse_driver_version", return_value="560.10.10"):
            check = provision._check_nvidia_driver()
        self.assertEqual(check["status"], "ok")
        self.assertNotIn("fix", check)

    def test_no_gpu_no_driver_is_info_not_fail(self):
        with mock.patch.object(provision, "gpu_info", return_value=[]), \
             mock.patch.object(provision, "_parse_driver_version", return_value=None):
            check = provision._check_nvidia_driver()
        self.assertEqual(check["status"], "info")
        self.assertNotIn("fix", check)

    def test_report_never_raises_when_everything_is_absent(self):
        with mock.patch.object(provision, "psutil", None), \
             mock.patch.object(provision, "gpu_info", return_value=[]), \
             mock.patch.object(provision, "cuda_device_count", return_value=0), \
             mock.patch.object(provision.shutil, "which", return_value=None), \
             mock.patch.object(provision.shutil, "disk_usage", side_effect=OSError("boom")), \
             mock.patch.dict(provision.os.environ, {}, clear=True):
            report = provision.detect()
        # Still produces a full, well-formed report.
        self.assertEqual([c["id"] for c in report["checks"]], EXPECTED_CHECK_IDS)
        self.assertIsInstance(report["ready"], bool)

    def test_individual_check_wrapper_never_raises(self):
        def boom() -> provision.Check:
            raise RuntimeError("kaboom")

        result = provision._check("x", "X", boom)
        self.assertEqual(result["status"], "unknown")
        self.assertIn("probe failed", result["detail"])


class ProvisionResourceCheckTests(unittest.TestCase):
    def test_low_ram_warns(self):
        fake_psutil = mock.Mock()
        fake_psutil.virtual_memory.return_value = mock.Mock(total=1024 * 1024 * 1024)  # 1 GiB
        with mock.patch.object(provision, "psutil", fake_psutil):
            check = provision._check_ram()
        self.assertEqual(check["status"], "warn")

    def test_ram_unknown_when_psutil_absent(self):
        with mock.patch.object(provision, "psutil", None):
            check = provision._check_ram()
        self.assertEqual(check["status"], "unknown")

    def test_disk_fail_when_under_floor(self):
        usage = mock.Mock(free=100 * 1024 * 1024)  # 100 MB
        with mock.patch.object(provision.shutil, "disk_usage", return_value=usage):
            check = provision._check_disk()
        self.assertEqual(check["status"], "fail")

    def test_disk_warn_between_floors(self):
        usage = mock.Mock(free=3 * 1024 * 1024 * 1024)  # 3 GiB
        with mock.patch.object(provision.shutil, "disk_usage", return_value=usage):
            check = provision._check_disk()
        self.assertEqual(check["status"], "warn")

    def test_ffmpeg_missing_emits_fix(self):
        with mock.patch.object(provision.shutil, "which", return_value=None), \
             mock.patch.dict(provision.os.environ, {}, clear=True):
            check = provision._check_ffmpeg()
        self.assertEqual(check["status"], "fail")
        self.assertEqual(check["fix"]["action"], "install_ffmpeg")

    def test_ffmpeg_found_on_path(self):
        with mock.patch.object(provision.shutil, "which", return_value="/usr/bin/ffmpeg"), \
             mock.patch.dict(provision.os.environ, {}, clear=True):
            check = provision._check_ffmpeg()
        self.assertEqual(check["status"], "ok")

    def test_vcredist_na_on_non_windows(self):
        with mock.patch.object(provision.platform, "system", return_value="Linux"):
            check = provision._check_vcredist()
        self.assertEqual(check["status"], "na")


class ProvisionVersionTests(unittest.TestCase):
    def test_driver_meets_minimum(self):
        self.assertTrue(provision._driver_meets_minimum("525.60.13", "525.60.13"))
        self.assertTrue(provision._driver_meets_minimum("560.0", "525.60.13"))
        self.assertFalse(provision._driver_meets_minimum("400.00", "525.60.13"))

    def test_version_tuple_handles_noise(self):
        self.assertEqual(provision._version_tuple("525.60.13"), (525, 60, 13))
        self.assertEqual(provision._version_tuple("v560a.1"), (560, 1))


class ProvisionDoctorAndCliTests(unittest.TestCase):
    def test_doctor_returns_formatted_checklist(self):
        text = provision.doctor()
        self.assertIn("system doctor", text)
        for label in ("Operating system", "ffmpeg", "NVIDIA driver"):
            self.assertIn(label, text)
        self.assertTrue("READY" in text or "NOT READY" in text)

    def test_cli_json_mode(self):
        with mock.patch("builtins.print") as printer:
            rc = provision.main([])
        self.assertEqual(rc, 0)
        printed = printer.call_args[0][0]
        self.assertIn('"ready"', printed)

    def test_cli_doctor_mode(self):
        with mock.patch("builtins.print") as printer:
            rc = provision.main(["--doctor"])
        self.assertEqual(rc, 0)
        printed = printer.call_args[0][0]
        self.assertIn("system doctor", printed)


if __name__ == "__main__":
    unittest.main()
