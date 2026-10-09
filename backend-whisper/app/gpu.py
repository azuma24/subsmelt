from __future__ import annotations

import functools
import platform
import subprocess
import sys
from typing import Literal, TypedDict

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover - psutil may be absent in minimal envs
    psutil = None

# CUDA / GPU detection helpers for the faster-whisper backend.
#
# faster-whisper runs on CTranslate2 (NOT torch). On a CPU-only dev box the
# ctranslate2 CUDA build, cudnn/cublas wheels and NVML may all be absent, so
# every probe in this module is import-guarded and degrades to "no GPU"
# (0 / empty list / False). NONE of these functions may raise on a CPU box.


class GpuInfo(TypedDict):
    name: str
    total_vram_mb: int
    free_vram_mb: int


class HostInfo(TypedDict):
    os: Literal["macos", "windows", "linux"]
    arch: Literal["arm64", "x86_64"]
    accelerator: Literal["metal", "cuda", "cpu"]
    gpuName: str | None
    memoryMb: int


def cuda_device_count() -> int:
    """Number of CUDA devices CTranslate2 can use, or 0 when unavailable.

    Wraps ``ctranslate2.get_cuda_device_count()``. Returns 0 if ctranslate2 is
    missing, has no CUDA support, or the call raises for any reason.
    """
    try:
        import ctranslate2  # type: ignore

        count = ctranslate2.get_cuda_device_count()
        return int(count) if count and count > 0 else 0
    except Exception:  # pragma: no cover - depends on optional CUDA runtime
        return 0


def has_cuda() -> bool:
    """True when at least one usable CUDA device is present."""
    return cuda_device_count() > 0


def _gpu_info_via_nvml() -> list[GpuInfo]:
    """Query GPUs via NVML (pynvml / nvidia-ml-py). Empty list if unavailable."""
    try:
        import pynvml  # type: ignore
    except Exception:  # pragma: no cover - optional dependency
        return []

    try:
        pynvml.nvmlInit()
    except Exception:  # pragma: no cover - driver/NVML not present
        return []

    gpus: list[GpuInfo] = []
    try:
        count = pynvml.nvmlDeviceGetCount()
        for index in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(index)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8", "replace")
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            gpus.append(
                {
                    "name": str(name),
                    "total_vram_mb": int(mem.total / 1024 / 1024),
                    "free_vram_mb": int(mem.free / 1024 / 1024),
                }
            )
    except Exception:  # pragma: no cover - any NVML query failure → no info
        gpus = []
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:  # pragma: no cover
            pass
    return gpus


def _gpu_info_via_nvidia_smi() -> list[GpuInfo]:
    """Query GPUs by parsing ``nvidia-smi`` CSV output. Empty list if absent."""
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except Exception:  # pragma: no cover - nvidia-smi not installed
        return []

    if completed.returncode != 0 or not completed.stdout.strip():
        return []

    gpus: list[GpuInfo] = []
    for line in completed.stdout.strip().splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 3:
            continue
        name, total, free = parts[0], parts[1], parts[2]
        try:
            gpus.append(
                {
                    "name": name,
                    "total_vram_mb": int(float(total)),
                    "free_vram_mb": int(float(free)),
                }
            )
        except ValueError:  # pragma: no cover - unexpected smi formatting
            continue
    return gpus


def gpu_info() -> list[GpuInfo]:
    """Detected GPUs with VRAM in MB.

    Tries NVML first (``pynvml`` / ``nvidia-ml-py``), then falls back to parsing
    ``nvidia-smi``. Returns ``[]`` when neither is available — never raises.
    """
    gpus = _gpu_info_via_nvml()
    if gpus:
        return gpus
    return _gpu_info_via_nvidia_smi()


def total_free_vram_mb() -> int | None:
    """Free VRAM on device 0, the card CTranslate2 loads on, or None when it
    can't be measured. A second card's memory is not available to the model."""
    gpus = gpu_info()
    return gpus[0]["free_vram_mb"] if gpus else None


def _sysctl(name: str) -> str | None:
    """One macOS ``sysctl -n`` value, or None when sysctl is missing or fails."""
    try:
        completed = subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=5, check=False)
    except Exception:
        return None
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and value else None


def _total_ram_mb() -> int:
    return int(psutil.virtual_memory().total / 1024 / 1024) if psutil is not None else 0


def _host_os() -> Literal["macos", "windows", "linux"]:
    if sys.platform == "darwin":
        return "macos"
    if sys.platform == "win32":
        return "windows"
    return "linux"


def _host_arch() -> Literal["arm64", "x86_64"]:
    return "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"


def _probe_host() -> HostInfo:
    os_name, arch = _host_os(), _host_arch()
    if cuda_device_count() > 0:
        cards = gpu_info()
        if cards:
            return {
                "os": os_name,
                "arch": arch,
                "accelerator": "cuda",
                "gpuName": cards[0]["name"],
                "memoryMb": cards[0]["total_vram_mb"],
            }
        return {"os": os_name, "arch": arch, "accelerator": "cuda", "gpuName": None, "memoryMb": _total_ram_mb()}
    if os_name == "macos":
        memsize = _sysctl("hw.memsize")
        memory_mb = int(memsize) // (1024 * 1024) if memsize and memsize.isdigit() else _total_ram_mb()
        # The GPU is part of the chip, so the chip name names it. system_profiler
        # would name it directly but takes seconds.
        return {
            "os": os_name,
            "arch": arch,
            "accelerator": "metal" if arch == "arm64" else "cpu",
            "gpuName": _sysctl("machdep.cpu.brand_string"),
            "memoryMb": memory_mb,
        }
    return {"os": os_name, "arch": arch, "accelerator": "cpu", "gpuName": None, "memoryMb": _total_ram_mb()}


@functools.cache
def host_info() -> HostInfo:
    """The OS, architecture and accelerator this backend runs on.

    Computed once per process, since none of it changes while the server runs.
    Never raises: a failed probe yields ``gpuName: None`` or a fallback memory size.
    """
    try:
        return _probe_host()
    except Exception:  # pragma: no cover - every probe above already degrades
        return {"os": _host_os(), "arch": _host_arch(), "accelerator": "cpu", "gpuName": None, "memoryMb": 0}


def apple_gpu_info() -> list[GpuInfo]:
    """The Apple GPU as a ``gpus`` entry on a Metal host, else ``[]``.

    The GPU shares system memory, so total and free come from RAM. Kept apart
    from :func:`gpu_info`, which feeds the CUDA VRAM preflight.
    """
    host = host_info()
    if host["accelerator"] != "metal":
        return []
    free_mb = int(psutil.virtual_memory().available / 1024 / 1024) if psutil is not None else 0
    return [{"name": host["gpuName"] or "Apple GPU", "total_vram_mb": host["memoryMb"], "free_vram_mb": free_mb}]
