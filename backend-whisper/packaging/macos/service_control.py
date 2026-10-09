"""launchctl control for the SubSmelt Whisper LaunchAgent — the macOS
counterpart of the Windows tray's sc.exe calls. The agent belongs to the
current user, so nothing here needs elevation."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

LABEL = os.environ.get("SUBSMELT_WHISPER_SERVICE", "com.subsmelt.whisper")


def _domain() -> str:
    return f"gui/{os.getuid()}"


def _target() -> str:
    return f"{_domain()}/{LABEL}"


def _plist() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def _run(command: list[str]) -> tuple[int, str]:
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:  # pragma: no cover - environment dependent
        return 1, str(exc)


def _loaded() -> tuple[int, str]:
    return _run(["launchctl", "print", _target()])


def start_service() -> tuple[int, str]:
    if _loaded()[0] != 0:
        code, out = _run(["launchctl", "bootstrap", _domain(), str(_plist())])
        if code != 0:
            return code, out
    return _run(["launchctl", "kickstart", _target()])


def stop_service() -> tuple[int, str]:
    # Unload rather than signal: the plist's KeepAlive restarts a killed server
    # within seconds. RunAtLoad loads it again at the next login.
    return _run(["launchctl", "bootout", _target()])


def service_status() -> str:
    code, out = _loaded()
    if code != 0:
        return "stopped" if _plist().exists() else "not installed"
    for line in out.splitlines():
        stripped = line.strip()
        if stripped.startswith("state = "):
            state = stripped[len("state = ") :].strip()
            return "running" if state == "running" else "stopped"
    return "unknown"
