"""Where the whisper-cli binary and the ggml weights are, and whether the
engine can run here. The loader holds a :class:`WhisperCppHandle` as the
resident "model", the way it holds a WhisperModel or a NemotronHandle."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .engine import EngineUnavailableError

BINARY_NAME = "whisper-cli"
BINARY_ENV_VAR = "SUBSMELT_WHISPER_CPP"
_VERSION_TIMEOUT_S = 15


@dataclass(frozen=True)
class WhisperCppHandle:
    binary: Path
    weights: Path


def bundled_binary_path() -> Path:
    """``<exe dir>/whisper-cpp/whisper-cli`` in the frozen macOS app, next to
    the ``app`` package in a source checkout."""
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).resolve().parent
    else:
        base = Path(__file__).resolve().parent.parent
    return base / "whisper-cpp" / BINARY_NAME


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


def _probe_version(binary: str) -> str | None:
    try:
        result = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=_VERSION_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    line = (result.stdout or result.stderr).strip().splitlines()
    return line[0].strip() if line else "unknown"


def availability() -> tuple[bool, str | None]:
    binary = resolve_binary()
    if binary is None:
        configured = os.environ.get(BINARY_ENV_VAR)
        if configured:
            return False, f"whisper-cli runtime not found at {configured}"
        return False, "whisper-cli runtime not found"
    if _probe_version(str(binary)) is None:
        return False, f"whisper-cli runtime at {binary} does not run"
    return True, None


def load_handle(weights: Path) -> WhisperCppHandle:
    binary = resolve_binary()
    if binary is None:
        raise EngineUnavailableError("whispercpp-large-v3-turbo", availability()[1] or "whisper-cli runtime not found")
    return WhisperCppHandle(binary=binary, weights=weights)


def find_weights(snapshot_dir: Path) -> Path | None:
    candidates = sorted(snapshot_dir.glob("ggml-*.bin"))
    return candidates[0] if candidates else None
