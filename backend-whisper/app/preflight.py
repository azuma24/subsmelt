from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import TypedDict

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover - psutil may be absent in minimal envs
    psutil = None


class SafetyResult(TypedDict):
    safe: bool
    code: str
    available_ram_mb: int
    required_ram_mb: int
    recommended_ram_mb: int
    suggested_model: str | None


class DiskSafetyResult(TypedDict):
    safe: bool
    code: str
    available_disk_mb: int
    required_disk_mb: int


MODEL_RAM_MB: dict[str, dict[str, int]] = {
    "tiny": {"required": 2048, "recommended": 4096},
    "base": {"required": 3072, "recommended": 4096},
    "small": {"required": 4096, "recommended": 8192},
    "medium": {"required": 8192, "recommended": 16384},
    "large": {"required": 16384, "recommended": 32768},
    "large-v2": {"required": 16384, "recommended": 32768},
    "large-v3": {"required": 16384, "recommended": 32768},
    "large-v3-turbo": {"required": 12288, "recommended": 24576},
}


def model_ram_requirements_mb(model: str) -> dict[str, int]:
    return MODEL_RAM_MB.get((model or "small").lower(), MODEL_RAM_MB["small"])


def suggest_model_for_ram(available_ram_mb: int) -> str | None:
    for model in ["small", "base", "tiny"]:
        if available_ram_mb >= MODEL_RAM_MB[model]["required"]:
            return model
    return None


def available_ram_mb() -> int:
    if psutil is not None:
        return int(psutil.virtual_memory().available / 1024 / 1024)
    # Conservative fallback when psutil is unavailable.
    return 0


def total_ram_mb() -> int:
    if psutil is not None:
        return int(psutil.virtual_memory().total / 1024 / 1024)
    return 0


def disk_free_mb(path: str | os.PathLike[str]) -> int:
    usage = shutil.disk_usage(path)
    return int(usage.free / 1024 / 1024)


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def evaluate_model_safety(model: str, available_ram_mb: int) -> SafetyResult:
    requirements = model_ram_requirements_mb(model)
    safe = available_ram_mb >= requirements["required"]
    return {
        "safe": safe,
        "code": "ok" if safe else "insufficient_ram",
        "available_ram_mb": available_ram_mb,
        "required_ram_mb": requirements["required"],
        "recommended_ram_mb": requirements["recommended"],
        "suggested_model": None if safe else suggest_model_for_ram(available_ram_mb),
    }


def evaluate_disk_safety(input_size_mb: int, available_disk_mb: int) -> DiskSafetyResult:
    # ffmpeg extraction plus output can temporarily need substantially more than
    # the source file. Keep a simple conservative floor for self-hosted users.
    required_disk_mb = max(2048, int(input_size_mb * 1.5))
    safe = available_disk_mb >= required_disk_mb
    return {
        "safe": safe,
        "code": "ok" if safe else "insufficient_disk",
        "available_disk_mb": available_disk_mb,
        "required_disk_mb": required_disk_mb,
    }


def assert_path_under_media(input_path: str, media_root: str = "/media") -> Path:
    root = Path(media_root).resolve()
    resolved = Path(input_path).resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"Input path is outside media directory: {input_path}")
    return resolved
