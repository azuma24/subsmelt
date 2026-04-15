"""Health / host-info route. Unauthenticated so subsmelt can probe cheaply."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..config import Settings, get_settings
from ..pipeline.whisper_runner import resolve_device

router = APIRouter(tags=["health"])


def _gpu_info() -> dict:
    info: dict = {"cuda_available": False, "gpu_name": None, "vram_free_bytes": None}
    try:
        import ctranslate2  # type: ignore

        count = ctranslate2.get_cuda_device_count()
        info["cuda_available"] = count > 0
        if count > 0:
            info["gpu_name"] = ctranslate2.get_cuda_device_name(0)
    except Exception:  # noqa: BLE001
        pass
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            info["cuda_available"] = True
            if not info.get("gpu_name"):
                info["gpu_name"] = torch.cuda.get_device_name(0)
            free, _total = torch.cuda.mem_get_info()
            info["vram_free_bytes"] = int(free)
    except Exception:  # noqa: BLE001
        pass
    return info


@router.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict:
    gpu = _gpu_info()
    return {
        "ok": True,
        "auth_required": not settings.auth_disabled,
        "device": resolve_device(settings.device),
        "compute_type": settings.compute_type,
        "max_concurrent": settings.max_concurrent,
        "media_dir": str(settings.media_dir),
        "models_dir": str(settings.models_dir),
        "gpu_name": gpu["gpu_name"],
        "cuda_available": gpu["cuda_available"],
        "vram_free_bytes": gpu["vram_free_bytes"],
    }
