"""Phase 0 CUDA-wiring tests.

These mock the GPU detection helpers so they pass on a CPU-only box with no
ctranslate2 CUDA build, no cudnn/cublas, and no NVIDIA driver. We never call a
real CUDA API here — only the import-guarded detection functions, which are
patched to simulate "GPU present" / "GPU absent".
"""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

# gpu / model_loader / preflight / schemas have no heavy runtime deps, so they
# import on a bare CPU box. main imports fastapi, which may be absent here — its
# tests are skipped when that import fails (mirrors test_streaming's pattern).
from app import gpu
from app.model_loader import (
    CudaUnavailableError,
    InvalidComputeTypeError,
    validate_device_and_compute_type,
)
from app.preflight import evaluate_gpu_safety

# schemas needs pydantic and main needs fastapi+pydantic — both may be absent on
# a bare CPU box, so the tests that need them are skipped (mirrors test_streaming).
try:
    from app import main
    from app.schemas import TranscribeRequest
except ModuleNotFoundError as exc:  # pragma: no cover - fastapi/pydantic optional here
    main = None
    TranscribeRequest = None
    MAIN_IMPORT_ERROR = exc
else:
    MAIN_IMPORT_ERROR = None


class GpuDetectionTests(unittest.TestCase):
    def test_cuda_device_count_returns_zero_when_ctranslate2_absent(self):
        # On this box ctranslate2 has no CUDA support; the helper must not raise.
        self.assertEqual(gpu.cuda_device_count(), 0)
        self.assertFalse(gpu.has_cuda())

    def test_gpu_info_returns_empty_list_on_cpu_box(self):
        # With no pynvml and no nvidia-smi the result is an empty list, not an error.
        with mock.patch.object(gpu, "_gpu_info_via_nvml", return_value=[]), mock.patch.object(
            gpu, "_gpu_info_via_nvidia_smi", return_value=[]
        ):
            self.assertEqual(gpu.gpu_info(), [])
            self.assertIsNone(gpu.total_free_vram_mb())

    def test_gpu_info_prefers_nvml_then_falls_back_to_smi(self):
        nvml_gpu = {"name": "NVML GPU", "total_vram_mb": 24000, "free_vram_mb": 20000}
        smi_gpu = {"name": "SMI GPU", "total_vram_mb": 8000, "free_vram_mb": 6000}
        with mock.patch.object(gpu, "_gpu_info_via_nvml", return_value=[nvml_gpu]):
            self.assertEqual(gpu.gpu_info(), [nvml_gpu])
        with mock.patch.object(gpu, "_gpu_info_via_nvml", return_value=[]), mock.patch.object(
            gpu, "_gpu_info_via_nvidia_smi", return_value=[smi_gpu]
        ):
            self.assertEqual(gpu.gpu_info(), [smi_gpu])
            self.assertEqual(gpu.total_free_vram_mb(), 6000)


@unittest.skipIf(MAIN_IMPORT_ERROR is not None, f"fastapi unavailable: {MAIN_IMPORT_ERROR}")
class CapabilitiesTests(unittest.TestCase):
    def test_capabilities_omits_cuda_when_no_gpu(self):
        with mock.patch.object(main, "cuda_device_count", return_value=0), mock.patch.object(
            main, "gpu_info", return_value=[]
        ):
            caps = main.capabilities()
        self.assertEqual(caps["devices"], ["cpu"])
        self.assertNotIn("cuda", caps["devices"])
        self.assertEqual(caps["computeTypes"], ["int8", "float32"])
        self.assertEqual(caps["gpus"], [])

    def test_capabilities_advertises_cuda_when_present(self):
        fake_gpu = {"name": "RTX 4090", "total_vram_mb": 24000, "free_vram_mb": 23000}
        with mock.patch.object(main, "cuda_device_count", return_value=1), mock.patch.object(
            main, "gpu_info", return_value=[fake_gpu]
        ):
            caps = main.capabilities()
        self.assertIn("cuda", caps["devices"])
        self.assertIn("float16", caps["computeTypes"])
        self.assertIn("int8_float16", caps["computeTypes"])
        self.assertEqual(caps["gpus"], [fake_gpu])


class DeviceValidationTests(unittest.TestCase):
    def test_device_cuda_without_gpu_raises_clear_error(self):
        with mock.patch("app.model_loader.cuda_device_count", return_value=0):
            with self.assertRaises(CudaUnavailableError) as ctx:
                validate_device_and_compute_type("cuda", "float16")
        self.assertIn("no CUDA device available", str(ctx.exception))
        self.assertIn("device=cpu", str(ctx.exception))

    def test_cpu_with_float16_raises_invalid_compute_type(self):
        with self.assertRaises(InvalidComputeTypeError):
            validate_device_and_compute_type("cpu", "float16")

    def test_cpu_with_int8_is_valid(self):
        # Should not raise.
        validate_device_and_compute_type("cpu", "int8")

    def test_cuda_with_valid_compute_type_passes_when_gpu_present(self):
        with mock.patch("app.model_loader.cuda_device_count", return_value=1):
            validate_device_and_compute_type("cuda", "float16")


class GpuSafetyTests(unittest.TestCase):
    def test_gpu_safety_fail_open_when_vram_unknown(self):
        result = evaluate_gpu_safety("large-v3", None)
        self.assertTrue(result["safe"])
        self.assertEqual(result["code"], "vram_unknown")
        self.assertEqual(result["free_vram_mb"], 0)

    def test_gpu_safety_blocks_when_insufficient_vram(self):
        result = evaluate_gpu_safety("large-v3", free_vram_mb=2048)
        self.assertFalse(result["safe"])
        self.assertEqual(result["code"], "insufficient_vram")
        self.assertIsNotNone(result["suggested_model"])

    def test_gpu_safety_passes_with_ample_vram(self):
        result = evaluate_gpu_safety("small", free_vram_mb=12000)
        self.assertTrue(result["safe"])
        self.assertEqual(result["code"], "ok")


@unittest.skipIf(MAIN_IMPORT_ERROR is not None, f"fastapi unavailable: {MAIN_IMPORT_ERROR}")
class PreflightGpuRoutingTests(unittest.TestCase):
    def test_preflight_uses_vram_when_device_cuda(self):
        request = TranscribeRequest(input_path="/media/clip.mkv", model="large-v3", device="cuda")
        fake_gpu = {"name": "RTX 3060", "total_vram_mb": 12000, "free_vram_mb": 1500}
        with mock.patch.object(main, "assert_path_under_media", return_value=Path("/media/clip.mkv")), \
             mock.patch.object(main, "available_ram_mb", return_value=64000), \
             mock.patch.object(main, "ffmpeg_available", return_value=True), \
             mock.patch.object(main, "disk_free_mb", return_value=500000), \
             mock.patch.object(main, "describe_model_cache", return_value=None), \
             mock.patch.object(main, "gpu_info", return_value=[fake_gpu]), \
             mock.patch.object(main, "total_free_vram_mb", return_value=1500):
            result = main.preflight_result(request)
        # Plenty of system RAM, but only 1.5 GB free VRAM → GPU path must block.
        self.assertFalse(result.safe)
        self.assertEqual(result.code, "insufficient_vram")
        self.assertEqual(result.device, "cuda")
        self.assertEqual(result.free_vram_mb, 1500)
        self.assertEqual(result.gpus, [fake_gpu])

    def test_preflight_vram_unknown_fails_open_on_cuda(self):
        request = TranscribeRequest(input_path="/media/clip.mkv", model="large-v3", device="cuda")
        with mock.patch.object(main, "assert_path_under_media", return_value=Path("/media/clip.mkv")), \
             mock.patch.object(main, "available_ram_mb", return_value=64000), \
             mock.patch.object(main, "ffmpeg_available", return_value=True), \
             mock.patch.object(main, "disk_free_mb", return_value=500000), \
             mock.patch.object(main, "describe_model_cache", return_value=None), \
             mock.patch.object(main, "gpu_info", return_value=[]), \
             mock.patch.object(main, "total_free_vram_mb", return_value=None):
            result = main.preflight_result(request)
        self.assertTrue(result.safe)
        self.assertEqual(result.code, "ok")
        self.assertEqual(result.device, "cuda")


if __name__ == "__main__":
    unittest.main()
