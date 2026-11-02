"""host_info() reports the OS, architecture and accelerator the backend runs on.

Every probe is patched (sys.platform, platform.machine, the CUDA count, NVML,
sysctl and psutil) so each host shape runs on any box.
"""

from __future__ import annotations

import subprocess
import unittest
from types import SimpleNamespace
from unittest import mock

from app import gpu

try:
    from fastapi.testclient import TestClient

    import app.main as main_module
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TestClient = None
    main_module = None
    ENDPOINT_IMPORT_ERROR = exc
else:
    ENDPOINT_IMPORT_ERROR = None

MIB = 1024 * 1024
MAC_HOST = {"os": "macos", "arch": "arm64", "accelerator": "metal", "gpuName": "Apple M5 Pro", "memoryMb": 49152}


def _sysctl_ok(argv, **_kwargs):
    values = {"machdep.cpu.brand_string": "Apple M5 Pro\n", "hw.memsize": f"{49152 * MIB}\n"}
    return subprocess.CompletedProcess(argv, 0, stdout=values[argv[-1]], stderr="")


def _sysctl_fails(argv, **_kwargs):
    return subprocess.CompletedProcess(argv, 1, stdout="", stderr="sysctl: unknown oid")


def _sysctl_missing(argv, **_kwargs):
    raise FileNotFoundError("sysctl")


def _fake_psutil(total_mb: int, available_mb: int = 0):
    memory = SimpleNamespace(total=total_mb * MIB, available=available_mb * MIB)
    return SimpleNamespace(virtual_memory=lambda: memory)


class HostInfoTests(unittest.TestCase):
    def setUp(self):
        gpu.host_info.cache_clear()
        self.addCleanup(gpu.host_info.cache_clear)

    def _host(self, *, platform, machine, cuda=0, nvml=(), run=_sysctl_ok, ram_mb=16384):
        with (
            mock.patch.object(gpu.sys, "platform", platform),
            mock.patch.object(gpu.platform, "machine", return_value=machine),
            mock.patch.object(gpu, "cuda_device_count", return_value=cuda),
            mock.patch.object(gpu, "_gpu_info_via_nvml", return_value=list(nvml)),
            mock.patch.object(gpu, "_gpu_info_via_nvidia_smi", return_value=[]),
            mock.patch.object(gpu.subprocess, "run", side_effect=run),
            mock.patch.object(gpu, "psutil", _fake_psutil(ram_mb)),
        ):
            return gpu.host_info()

    def test_macos_arm64_is_metal_with_the_chip_name(self):
        self.assertEqual(self._host(platform="darwin", machine="arm64"), MAC_HOST)

    def test_sysctl_is_called_by_absolute_path_so_a_minimal_path_still_finds_it(self):
        # launchd and `env -i` give PATH=/usr/bin:/bin, which lacks /usr/sbin.
        calls = []

        def run(argv, **kwargs):
            calls.append(argv[0])
            return _sysctl_ok(argv, **kwargs)

        self._host(platform="darwin", machine="arm64", run=run)
        self.assertEqual(set(calls), {"/usr/sbin/sysctl"})

    def test_windows_with_one_cuda_device_is_cuda_with_the_nvml_name_and_vram(self):
        card = {"name": "NVIDIA GeForce RTX 4090", "total_vram_mb": 24564, "free_vram_mb": 20000}
        host = self._host(platform="win32", machine="AMD64", cuda=1, nvml=[card], ram_mb=65536)
        self.assertEqual(
            host,
            {
                "os": "windows",
                "arch": "x86_64",
                "accelerator": "cuda",
                "gpuName": "NVIDIA GeForce RTX 4090",
                "memoryMb": 24564,
            },
        )

    def test_linux_without_cuda_is_cpu_with_no_gpu_name(self):
        host = self._host(platform="linux", machine="x86_64", ram_mb=8192)
        self.assertEqual(
            host, {"os": "linux", "arch": "x86_64", "accelerator": "cpu", "gpuName": None, "memoryMb": 8192}
        )

    def test_linux_aarch64_reports_arm64(self):
        host = self._host(platform="linux", machine="aarch64", ram_mb=4096)
        self.assertEqual(
            host, {"os": "linux", "arch": "arm64", "accelerator": "cpu", "gpuName": None, "memoryMb": 4096}
        )

    def test_failing_sysctl_gives_no_gpu_name_and_does_not_raise(self):
        host = self._host(platform="darwin", machine="arm64", run=_sysctl_fails, ram_mb=49152)
        self.assertEqual(
            host, {"os": "macos", "arch": "arm64", "accelerator": "metal", "gpuName": None, "memoryMb": 49152}
        )

    def test_missing_sysctl_binary_gives_no_gpu_name_and_does_not_raise(self):
        host = self._host(platform="darwin", machine="arm64", run=_sysctl_missing, ram_mb=49152)
        self.assertEqual(
            host, {"os": "macos", "arch": "arm64", "accelerator": "metal", "gpuName": None, "memoryMb": 49152}
        )

    def test_computed_once_per_process(self):
        first = self._host(platform="darwin", machine="arm64")
        # A second call with a different (patched) host still returns the first answer.
        second = self._host(platform="linux", machine="x86_64")
        self.assertEqual(second, first)


class AppleGpuEntryTests(unittest.TestCase):
    def test_metal_host_lists_the_apple_gpu_with_system_memory(self):
        with (
            mock.patch.object(gpu, "host_info", return_value=MAC_HOST),
            mock.patch.object(gpu, "psutil", _fake_psutil(49152, available_mb=30000)),
        ):
            self.assertEqual(
                gpu.apple_gpu_info(), [{"name": "Apple M5 Pro", "total_vram_mb": 49152, "free_vram_mb": 30000}]
            )

    def test_non_metal_host_lists_no_apple_gpu(self):
        linux = {"os": "linux", "arch": "x86_64", "accelerator": "cpu", "gpuName": None, "memoryMb": 8192}
        with mock.patch.object(gpu, "host_info", return_value=linux):
            self.assertEqual(gpu.apple_gpu_info(), [])


@unittest.skipIf(
    ENDPOINT_IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {ENDPOINT_IMPORT_ERROR}"
)
class HostEndpointTests(unittest.TestCase):
    def setUp(self):
        apple = [{"name": "Apple M5 Pro", "total_vram_mb": 49152, "free_vram_mb": 30000}]
        for target, value in (
            ("host_info", MAC_HOST),
            ("apple_gpu_info", apple),
            ("gpu_info", []),
            ("cuda_device_count", 0),
        ):
            patcher = mock.patch.object(main_module, target, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = TestClient(main_module.app)

    def test_health_capabilities_keep_host_and_list_the_apple_gpu(self):
        caps = self.client.get("/health").json()["capabilities"]
        self.assertEqual(caps["host"], MAC_HOST)
        self.assertEqual(caps["gpus"], [{"name": "Apple M5 Pro", "total_vram_mb": 49152, "free_vram_mb": 30000}])
        self.assertEqual(caps["devices"], ["cpu"])

    def test_version_capabilities_match_health(self):
        self.assertEqual(
            self.client.get("/version").json()["capabilities"]["host"],
            self.client.get("/health").json()["capabilities"]["host"],
        )
