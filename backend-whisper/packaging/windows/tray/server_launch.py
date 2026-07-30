#!/usr/bin/env python3
"""Locate the run_server executable that the tray / GUI controllers launch.

Both whisper_tray.py and whisper_gui.py used to assume run_server.exe sits
directly next to their own exe. That holds only for the copies build-local.ps1
places in dist\\whisper-server\\ — a user who launches the PyInstaller output
left in dist\\ (dist\\whisper-gui.exe) has no sibling server, and Popen fails
with the bare, unhelpful "[WinError 2] The system cannot find the file
specified".

This module searches the plausible layouts instead, and when nothing matches it
reports every path it tried plus the env override, so the failure is actionable.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

# Full path to run_server.exe; wins over every probed location.
SERVER_EXE_ENV = "SUBSMELT_WHISPER_SERVER_EXE"
# PyInstaller onedir bundle directory name (whisper-server.spec COLLECT name).
BUNDLE_DIR_NAME = "whisper-server"


class ServerExecutableNotFound(RuntimeError):
    """Raised when no run_server executable can be resolved."""

    def __init__(self, searched: list[Path]) -> None:
        self.searched = list(searched)
        locations = "\n  ".join(str(path) for path in self.searched) or "(nowhere)"
        super().__init__(
            "run_server executable not found. Looked in:\n  "
            f"{locations}\n\n"
            "Launch the copy of this app that sits next to run_server.exe "
            f"(the {BUNDLE_DIR_NAME}\\ bundle directory), or set "
            f"{SERVER_EXE_ENV} to the full path of run_server.exe."
        )


def server_exe_name(windows: bool | None = None) -> str:
    """File name of the frozen server launcher for the target platform."""
    if windows is None:
        windows = os.name == "nt"
    return "run_server.exe" if windows else "run_server"


def server_exe_candidates(exe_dir: Path, windows: bool | None = None) -> list[Path]:
    """Paths to probe, most specific first, for an app living in exe_dir."""
    name = server_exe_name(windows)
    return [
        exe_dir / name,                          # installed bundle / dist\whisper-server
        exe_dir / BUNDLE_DIR_NAME / name,        # launched from dist\
        exe_dir.parent / BUNDLE_DIR_NAME / name, # launched from a sibling folder
        exe_dir / "_internal" / name,            # PyInstaller >= 6 onedir layout
    ]


def find_server_exe(
    exe_dir: Path,
    env: dict[str, str] | None = None,
    windows: bool | None = None,
) -> tuple[Path | None, list[Path]]:
    """Return (resolved executable or None, every path that was probed)."""
    environ = os.environ if env is None else env
    searched: list[Path] = []

    override = (environ.get(SERVER_EXE_ENV) or "").strip()
    if override:
        candidate = Path(override)
        searched.append(candidate)
        if candidate.is_file():
            return candidate, searched

    for candidate in server_exe_candidates(Path(exe_dir), windows=windows):
        searched.append(candidate)
        if candidate.is_file():
            return candidate, searched

    on_path = shutil.which(server_exe_name(windows))
    if on_path:
        return Path(on_path), searched

    return None, searched


def resolve_server_command(dev_script: Path) -> list[str]:
    """Build the argv that starts the server.

    Frozen: a resolved run_server executable. Dev: the repo's run_server.py run
    with the current interpreter. Raises ServerExecutableNotFound when neither
    is available, so callers can surface a real explanation to the user.
    """
    if getattr(sys, "frozen", False):
        found, searched = find_server_exe(Path(sys.executable).parent)
        if found is None:
            raise ServerExecutableNotFound(searched)
        return [str(found)]

    script = Path(dev_script)
    if not script.is_file():
        raise ServerExecutableNotFound([script])
    return [sys.executable, str(script)]
