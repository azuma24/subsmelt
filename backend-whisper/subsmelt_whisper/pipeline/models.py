"""
Model cache management:

- Enumerate what's cached on disk.
- A curated catalog of known-good Whisper + UVR models.
- Download into the models directory (used as a background task).

Whisper models live under ``<models_dir>/whisper/<name>`` — that's also where
faster-whisper's ``download_root`` points. UVR models live under
``<models_dir>/uvr/<filename>``.
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

WHISPER_CATALOG: list["CatalogEntry"] = []
UVR_CATALOG: list["CatalogEntry"] = []


@dataclass
class CatalogEntry:
    name: str
    repo_id: str
    size_hint: str
    description: str


@dataclass
class CachedModel:
    name: str
    path: str
    size_bytes: int


def _mk_whisper(name: str, repo_id: str, size_hint: str, description: str) -> CatalogEntry:
    return CatalogEntry(name=name, repo_id=repo_id, size_hint=size_hint, description=description)


WHISPER_CATALOG = [
    _mk_whisper("tiny", "Systran/faster-whisper-tiny", "~75 MB", "Fastest, lowest accuracy. Good for smoke tests."),
    _mk_whisper("base", "Systran/faster-whisper-base", "~140 MB", "Small, fast, decent for clean audio."),
    _mk_whisper("small", "Systran/faster-whisper-small", "~460 MB", "Balanced speed/quality."),
    _mk_whisper("medium", "Systran/faster-whisper-medium", "~1.5 GB", "Higher quality, slower."),
    _mk_whisper("large-v2", "Systran/faster-whisper-large-v2", "~3 GB", "Prior flagship model."),
    _mk_whisper("large-v3", "Systran/faster-whisper-large-v3", "~3 GB", "Current flagship, most accurate."),
    _mk_whisper(
        "large-v3-turbo",
        "deepdml/faster-whisper-large-v3-turbo-ct2",
        "~1.6 GB",
        "Distilled large-v3; near-flagship quality at ~4x speed.",
    ),
    _mk_whisper(
        "distil-large-v3",
        "Systran/faster-distil-whisper-large-v3",
        "~1.5 GB",
        "English-only distilled large-v3, very fast.",
    ),
]

UVR_CATALOG = [
    CatalogEntry(
        name="UVR-MDX-NET-Inst_HQ_3.onnx",
        repo_id="UVR-MDX-NET-Inst_HQ_3.onnx",
        size_hint="~65 MB",
        description="Default UVR MDX-NET instrumental remover (keeps vocals).",
    ),
    CatalogEntry(
        name="UVR-MDX-NET-Voc_FT.onnx",
        repo_id="UVR-MDX-NET-Voc_FT.onnx",
        size_hint="~65 MB",
        description="Vocals fine-tuned MDX-NET, cleaner speech extraction.",
    ),
    CatalogEntry(
        name="Kim_Vocal_2.onnx",
        repo_id="Kim_Vocal_2.onnx",
        size_hint="~65 MB",
        description="Popular community vocals model.",
    ),
]


def _dir_size(path: Path) -> int:
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            try:
                total += child.stat().st_size
            except OSError:
                pass
    return total


def list_cached_whisper(models_dir: Path) -> list[CachedModel]:
    root = models_dir / "whisper"
    if not root.exists():
        return []
    out: list[CachedModel] = []
    # faster-whisper writes hub-style cache with "models--owner--name" folder names
    # as well as plain subfolders when download_root is used directly. Normalise.
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        name = child.name
        if name.startswith("models--"):
            name = name.replace("models--", "", 1).replace("--", "/")
        out.append(CachedModel(name=name, path=str(child), size_bytes=_dir_size(child)))
    return out


def list_cached_uvr(models_dir: Path) -> list[CachedModel]:
    root = models_dir / "uvr"
    if not root.exists():
        return []
    out: list[CachedModel] = []
    for child in sorted(root.iterdir()):
        if child.is_file() and child.suffix.lower() in (".onnx", ".pth", ".ckpt"):
            out.append(
                CachedModel(
                    name=child.name,
                    path=str(child),
                    size_bytes=child.stat().st_size,
                )
            )
    return out


def catalog_json() -> dict:
    return {
        "whisper": {
            "catalog": [asdict(e) for e in WHISPER_CATALOG],
        },
        "uvr": {
            "catalog": [asdict(e) for e in UVR_CATALOG],
        },
    }


def cached_json(models_dir: Path) -> dict:
    return {
        "whisper": {
            "cached": [asdict(m) for m in list_cached_whisper(models_dir)],
        },
        "uvr": {
            "cached": [asdict(m) for m in list_cached_uvr(models_dir)],
        },
    }


def delete_cached(models_dir: Path, kind: str, name: str) -> bool:
    if kind not in ("whisper", "uvr"):
        raise ValueError(f"Unknown model kind: {kind}")
    root = models_dir / kind
    # Disallow path traversal.
    if "/" in name or "\\" in name or name in ("", ".", ".."):
        raise ValueError("Invalid model name")
    target = root / name
    if not target.exists():
        # Try hub-style folder name for whisper
        if kind == "whisper":
            alt = root / ("models--" + name.replace("/", "--"))
            if alt.exists():
                target = alt
            else:
                return False
        else:
            return False
    if target.is_dir():
        shutil.rmtree(target, ignore_errors=True)
    else:
        target.unlink(missing_ok=True)
    return True


def run_model_download(task_id: str, store) -> None:
    """Background runner: downloads a model and updates the task row."""
    task = store.get(task_id)
    if task is None:
        return
    from ..config import get_settings

    settings = get_settings()
    kind = task.model_kind or ""
    name = task.model_name or ""
    store.update(task_id, status="running", stage="downloading", progress=0.0, error=None)
    try:
        if kind == "whisper":
            _download_whisper(name, settings.models_dir, store, task_id)
        elif kind == "uvr":
            _download_uvr(name, settings.models_dir, store, task_id)
        else:
            raise ValueError(f"Unknown model kind: {kind}")
        store.update(task_id, status="done", stage=None, progress=1.0)
    except Exception as exc:  # noqa: BLE001
        log.exception("Model download failed: task=%s kind=%s name=%s", task_id, kind, name)
        store.update(task_id, status="error", stage=None, error=str(exc))


def _download_whisper(name: str, models_dir: Path, store, task_id: str) -> None:
    """
    Touch faster-whisper's downloader by instantiating the WhisperModel with
    ``download_root`` pointing at our cache. HuggingFace hub does the actual work.
    """
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:
        raise RuntimeError("faster-whisper not installed") from exc

    entry = next((e for e in WHISPER_CATALOG if e.name == name), None)
    model_id = entry.repo_id if entry else name
    store.update(task_id, progress=0.05)
    # Load onto CPU to keep VRAM free during pre-pulls.
    WhisperModel(
        model_id,
        device="cpu",
        compute_type="int8",
        download_root=str(models_dir / "whisper"),
    )
    store.update(task_id, progress=0.99)


def _download_uvr(filename: str, models_dir: Path, store, task_id: str) -> None:
    """
    Ask audio-separator to load a model by filename; it downloads on demand.
    """
    try:
        from audio_separator.separator import Separator  # type: ignore
    except Exception as exc:
        raise RuntimeError("audio-separator not installed") from exc

    (models_dir / "uvr").mkdir(parents=True, exist_ok=True)
    store.update(task_id, progress=0.05)
    separator = Separator(
        model_file_dir=str(models_dir / "uvr"),
        output_dir=str(models_dir / "uvr" / "_tmp"),
    )
    separator.load_model(model_filename=filename)
    store.update(task_id, progress=0.99)
