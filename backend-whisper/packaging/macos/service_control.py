"""launchctl control for the SubSmelt Whisper LaunchAgent — the macOS
counterpart of the Windows tray's sc.exe calls. The agent belongs to the
current user, so nothing here needs elevation."""

from __future__ import annotations

import os
import subprocess

LABEL = os.environ.get("SUBSMELT_WHISPER_SERVICE", "com.subsmelt.whisper")


def _target() -> str:
    return f"gui/{os.getuid()}/{LABEL}"


def _run(command: list[str]) -> tuple[int, str]:
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:  # pragma: no cover - environment dependent
        return 1, str(exc)


def start_service() -> tuple[int, str]:
    return _run(["launchctl", "kickstart", _target()])


def stop_service() -> tuple[int, str]:
    return _run(["launchctl", "kill", "SIGTERM", _target()])


def service_status() -> str:
    code, out = _run(["launchctl", "print", _target()])
    if code != 0:
        return "not installed"
    for line in out.splitlines():
        stripped = line.strip()
        if stripped.startswith("state = "):
            state = stripped[len("state = ") :].strip()
            return "running" if state == "running" else "stopped"
    return "unknown"
