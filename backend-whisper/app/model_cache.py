from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping, TypedDict

from .preflight import evaluate_model_safety


class ModelCacheInfo(TypedDict):
    model: str
    cached: bool | None
    cache_root: str
    cache_path: str | None
    first_run_download_expected: bool
    required_ram_mb: int
    recommended_ram_mb: int
    suggested_model: str | None
    warning: str


EnvMapping = Mapping[str, str]


def cache_root_from_env(env: EnvMapping | None = None) -> Path:
    source = env if env is not None else os.environ
    hf_home = source.get("HF_HOME")
    if hf_home:
        return Path(hf_home).expanduser()
    xdg_cache_home = source.get("XDG_CACHE_HOME")
    if xdg_cache_home:
        return Path(xdg_cache_home).expanduser() / "huggingface"
    return Path.home() / ".cache" / "huggingface"


def _looks_like_local_path(model: str) -> bool:
    return model.startswith(("/", "./", "../", "~")) or "\\" in model


def _candidate_cache_paths(model: str, cache_root: Path) -> list[Path]:
    normalized = (model or "").strip().lower()
    repo_name = f"faster-whisper-{normalized}"
    return [
        cache_root / "hub" / f"models--Systran--{repo_name}" / "snapshots",
        cache_root / f"models--Systran--{repo_name}" / "snapshots",
        cache_root / repo_name,
        cache_root / normalized,
    ]


def _first_existing_path(candidates: list[Path]) -> Path | None:
    for candidate in candidates:
        if candidate.is_dir():
            if candidate.name == "snapshots":
                snapshots = sorted((path for path in candidate.iterdir() if path.is_dir()), key=lambda path: path.name)
                if snapshots:
                    return snapshots[-1]
            return candidate
    return None


def describe_model_cache(model: str, available_ram_mb: int, env: EnvMapping | None = None) -> ModelCacheInfo:
    selected_model = (model or "small").strip() or "small"
    safety = evaluate_model_safety(selected_model, available_ram_mb)

    if _looks_like_local_path(selected_model):
        local_path = Path(selected_model).expanduser()
        cache_path = local_path if local_path.exists() else None
        cached = local_path.exists()
        warning = (
            "Selected model path is not present yet. The first real transcription will fail until it exists."
            if not cached
            else "Selected model uses a local path; cache status is based only on whether that path exists."
        )
        return {
            "model": selected_model,
            "cached": cached,
            "cache_root": str(local_path.parent),
            "cache_path": str(cache_path) if cache_path else None,
            "first_run_download_expected": not cached,
            "required_ram_mb": safety["required_ram_mb"],
            "recommended_ram_mb": safety["recommended_ram_mb"],
            "suggested_model": safety["suggested_model"],
            "warning": warning,
        }

    cache_root = cache_root_from_env(env)
    cache_path = _first_existing_path(_candidate_cache_paths(selected_model, cache_root))
    cached = cache_path is not None
    warning = (
        "Selected model is not cached yet. The first real transcription may download model weights into the configured cache root."
        if not cached
        else "Selected model appears to be present in the configured cache root."
    )
    return {
        "model": selected_model,
        "cached": cached,
        "cache_root": str(cache_root),
        "cache_path": str(cache_path) if cache_path else None,
        "first_run_download_expected": not cached,
        "required_ram_mb": safety["required_ram_mb"],
        "recommended_ram_mb": safety["recommended_ram_mb"],
        "suggested_model": safety["suggested_model"],
        "warning": warning,
    }
