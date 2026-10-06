from __future__ import annotations

import os
import shutil
from dataclasses import asdict
from pathlib import Path
from typing import TypedDict

from .audio import ffmpeg_binary
from .catalog import DEFAULT_MODEL_ID, ModelDescriptor, descriptor_for, downgrade_candidates

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


class GpuSafetyResult(TypedDict):
    safe: bool
    code: str
    free_vram_mb: int
    required_vram_mb: int
    recommended_vram_mb: int
    suggested_model: str | None


DIARIZATION_RAM_MB = 2048
DIARIZATION_VRAM_MB = 2048


def _descriptor(model: str) -> ModelDescriptor:
    """Unknown ids (local paths, typos) are gated like the default model."""
    return descriptor_for(model) or descriptor_for(DEFAULT_MODEL_ID)


def model_ram_requirements_mb(model: str) -> dict[str, int]:
    return asdict(_descriptor(model).ram_mb)


def model_vram_requirements_mb(model: str) -> dict[str, int]:
    return asdict(_descriptor(model).vram_mb)


def suggest_model_for_vram(model: str, free_vram_mb: int) -> str | None:
    for candidate in downgrade_candidates(model):
        if free_vram_mb >= candidate.vram_mb.required:
            return candidate.id
    return None


def suggest_model_for_ram(model: str, available_ram_mb: int) -> str | None:
    for candidate in downgrade_candidates(model):
        if available_ram_mb >= candidate.ram_mb.required:
            return candidate.id
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


# Sentinel for "free space could not be measured" — negative so it can never be
# mistaken for a real reading of 0 MB (which would read as "disk full").
DISK_FREE_UNKNOWN = -1


def disk_free_mb(path: str | os.PathLike[str]) -> int:
    """Free space in MB for the filesystem holding ``path``.

    ``shutil.disk_usage`` needs a path that exists — a media root on an offline
    mount or a not-yet-created directory made it raise, which surfaced as an
    opaque 500 from /transcribe and /transcribe/preflight. Walk up to the first
    existing ancestor instead, and report -1 ("unknown") if even that fails so
    callers can fail open rather than read 0 as "disk full".
    """
    probe = Path(path)
    while not probe.exists():
        parent = probe.parent
        if parent == probe:
            break
        probe = parent
    try:
        usage = shutil.disk_usage(probe)
    except OSError:
        return DISK_FREE_UNKNOWN
    return int(usage.free / 1024 / 1024)


def ffmpeg_available() -> bool:
    # Same resolver extract_audio uses, so a bundled SUBSMELT_FFMPEG that is not
    # on PATH (the Windows service) passes preflight instead of "ffmpeg_missing".
    return shutil.which(ffmpeg_binary()) is not None


def evaluate_model_safety(model: str, available_ram_mb: int) -> SafetyResult:
    requirements = model_ram_requirements_mb(model)
    # available_ram_mb <= 0 means we could not measure RAM (e.g. psutil missing).
    # Fail OPEN in that case — blocking every transcription on an unknown reading
    # is worse than proceeding; report "ram_unknown" so the UI can warn instead.
    if available_ram_mb <= 0:
        return {
            "safe": True,
            "code": "ram_unknown",
            "available_ram_mb": available_ram_mb,
            "required_ram_mb": requirements["required"],
            "recommended_ram_mb": requirements["recommended"],
            "suggested_model": None,
        }
    safe = available_ram_mb >= requirements["required"]
    return {
        "safe": safe,
        "code": "ok" if safe else "insufficient_ram",
        "available_ram_mb": available_ram_mb,
        "required_ram_mb": requirements["required"],
        "recommended_ram_mb": requirements["recommended"],
        "suggested_model": None if safe else suggest_model_for_ram(model, available_ram_mb),
    }


def evaluate_gpu_safety(model: str, free_vram_mb: int | None) -> GpuSafetyResult:
    """Mirror of :func:`evaluate_model_safety` against VRAM for the CUDA path.

    ``free_vram_mb`` is the measured free GPU memory (from ``gpu.gpu_info``).
    When it is ``None`` (or non-positive) VRAM could not be measured — fail OPEN
    with code ``vram_unknown``, matching the ``ram_unknown`` fail-open behaviour,
    rather than blocking every GPU transcription on an unknown reading.
    """
    requirements = model_vram_requirements_mb(model)
    if free_vram_mb is None or free_vram_mb <= 0:
        return {
            "safe": True,
            "code": "vram_unknown",
            "free_vram_mb": free_vram_mb or 0,
            "required_vram_mb": requirements["required"],
            "recommended_vram_mb": requirements["recommended"],
            "suggested_model": None,
        }
    safe = free_vram_mb >= requirements["required"]
    return {
        "safe": safe,
        "code": "ok" if safe else "insufficient_vram",
        "free_vram_mb": free_vram_mb,
        "required_vram_mb": requirements["required"],
        "recommended_vram_mb": requirements["recommended"],
        "suggested_model": None if safe else suggest_model_for_vram(model, free_vram_mb),
    }


def evaluate_disk_safety(input_size_mb: int, available_disk_mb: int) -> DiskSafetyResult:
    # ffmpeg extraction plus output can temporarily need substantially more than
    # the source file. Keep a simple conservative floor for self-hosted users.
    required_disk_mb = max(2048, int(input_size_mb * 1.5))
    # Unmeasurable free space fails OPEN, matching evaluate_model_safety's
    # ram_unknown: refusing every transcription over an unknown reading is worse
    # than proceeding, and the code lets the UI warn instead.
    if available_disk_mb < 0:
        return {
            "safe": True,
            "code": "disk_unknown",
            "available_disk_mb": available_disk_mb,
            "required_disk_mb": required_disk_mb,
        }
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
