"""Where the nemo-speech binary and the Nemotron weights are, and whether the
engine can run here. The loader holds a :class:`NemotronHandle` as the
resident "model" the way it holds a WhisperModel for Whisper."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .engine import EngineUnavailableError
from .nemotron_languages import NEMOTRON_MODEL_ID

BINARY_NAME = "nemo-speech"
BINARY_ENV_VAR = "SUBSMELT_NEMO_SPEECH"
_VERSION_TIMEOUT_S = 15


@dataclass(frozen=True)
class NemotronHandle:
    binary: Path
    gguf: Path


def bundled_binary_path() -> Path:
    """``<install dir>/nemo-speech/bin/nemo-speech[.exe]``: next to the frozen
    executable on Windows, next to the ``app`` package in a source checkout."""
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).resolve().parent
    else:
        base = Path(__file__).resolve().parent.parent
    name = BINARY_NAME + (".exe" if os.name == "nt" else "")
    return base / "nemo-speech" / "bin" / name


def _runnable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def resolve_binary() -> Path | None:
    """The env var wins and is authoritative: a configured path that is missing
    is a configuration error, not a reason to fall back to PATH."""
    configured = os.environ.get(BINARY_ENV_VAR)
    if configured:
        path = Path(configured).expanduser()
        return path if _runnable(path) else None
    bundled = bundled_binary_path()
    if _runnable(bundled):
        return bundled
    found = shutil.which(BINARY_NAME)
    return Path(found) if found else None


@lru_cache(maxsize=8)
def _version_of(binary: str) -> str | None:
    try:
        result = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=_VERSION_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return None
    line = (result.stdout or result.stderr).strip().splitlines()
    if not line:
        return None
    return line[0].split()[-1]


def binary_version() -> str | None:
    binary = resolve_binary()
    return _version_of(str(binary)) if binary else None


def availability() -> tuple[bool, str | None]:
    binary = resolve_binary()
    if binary is not None:
        if _version_of(str(binary)) is None:
            return False, f"nemo-speech runtime at {binary} does not run"
        return True, None
    configured = os.environ.get(BINARY_ENV_VAR)
    if configured:
        return False, f"nemo-speech runtime not found at {configured}"
    return False, "nemo-speech runtime not found"


def find_gguf(snapshot_dir: Path) -> Path | None:
    candidates = sorted(snapshot_dir.glob("*.gguf"))
    return candidates[0] if candidates else None


def load_handle(gguf: Path) -> NemotronHandle:
    binary = resolve_binary()
    if binary is None:
        raise EngineUnavailableError(NEMOTRON_MODEL_ID, availability()[1] or "nemo-speech runtime not found")
    return NemotronHandle(binary=binary, gguf=gguf)
