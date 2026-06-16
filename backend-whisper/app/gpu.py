from __future__ import annotations

import subprocess
from typing import TypedDict

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
    """Total free VRAM across detected GPUs, or None when it can't be measured."""
    gpus = gpu_info()
    if not gpus:
        return None
    return sum(gpu["free_vram_mb"] for gpu in gpus)
