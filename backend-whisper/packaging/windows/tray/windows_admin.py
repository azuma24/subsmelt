#!/usr/bin/env python3
"""Administrator-only actions for the Whisper control window and tray.

The installed SubSmeltWhisper service runs as LocalSystem, and the installer
lets only SYSTEM and Administrators change its config.json (Users may read it).
The control apps run unelevated on purpose. Each admin action
goes through its own UAC prompt (ShellExecute "runas"), never by elevating the
whole app or by loosening the ACL.

Also answers "is the installed service the thing on this port?". Without that,
the window reported the service as an unknown server and refused to start, and
killing the PID did not help because the service manager restarts it.

Kept free of tkinter so it can be tested anywhere.
"""

from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

SERVICE_NAME = os.environ.get("SUBSMELT_WHISPER_SERVICE", "SubSmeltWhisper")

# Win32 ERROR_CANCELLED: what ShellExecute reports when the UAC prompt is declined.
ERROR_CANCELLED = 1223

CREATE_NO_WINDOW = 0x08000000  # a windowed exe would flash a console per command

Runner = Callable[[list[str]], tuple[int, str]]


def is_windows() -> bool:
    return os.name == "nt"


def run(cmd: list[str]) -> tuple[int, str]:
    """Run a command, returning (returncode, combined output). Never raises."""
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            creationflags=CREATE_NO_WINDOW if is_windows() else 0,
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:  # pragma: no cover - environment dependent
        return 1, str(exc)


# ---------------------------------------------------------------------------
# UAC elevation
# ---------------------------------------------------------------------------


class ElevationDeclined(Exception):
    """The operator said no at the UAC prompt."""


class ElevatedActionFailed(Exception):
    """The elevated program could not be launched or exited non-zero."""


def _ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def elevated_command(program: str, arguments: list[str], wait: bool) -> list[str]:
    """PowerShell that runs `program` behind a UAC prompt.

    A declined prompt surfaces as a Win32Exception with ERROR_CANCELLED wrapped
    inside Start-Process's own error, so the script walks the inner exceptions
    and exits with that code. Any other failure exits 1 with its message on
    stderr. With `wait`, the elevated program's own exit code is passed back.
    """
    launch = (
        f"Start-Process -FilePath {_ps_quote(program)} "
        f"-ArgumentList {','.join(_ps_quote(arg) for arg in arguments)} -Verb RunAs -PassThru"
    )
    if wait:
        launch += " -Wait -WindowStyle Hidden"
    finish = "exit $p.ExitCode" if wait else "exit 0"
    script = (
        f"try {{ $p = {launch}; {finish} }} catch {{ "
        "$e = $_.Exception; "
        "while ($e) { "
        f"if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq {ERROR_CANCELLED}) "
        f"{{ exit {ERROR_CANCELLED} }}; "
        "$e = $e.InnerException }; "
        "[Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
    )
    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]


def run_elevated(program: str, arguments: list[str], wait: bool, runner: Runner | None = None) -> None:
    """Run `program` elevated; raises ElevationDeclined or ElevatedActionFailed."""
    code, output = (runner or run)(elevated_command(program, arguments, wait))
    if code == ERROR_CANCELLED:
        raise ElevationDeclined()
    if code != 0:
        detail = _last_line(output)
        raise ElevatedActionFailed(f"exit code {code}" + (f": {detail}" if detail else ""))


def _last_line(output: str) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return lines[-1] if lines else ""


# ---------------------------------------------------------------------------
# The installed service
# ---------------------------------------------------------------------------

SERVICE_ACTIONS = {"start": "Start-Service", "stop": "Stop-Service", "restart": "Restart-Service"}


@dataclass(frozen=True)
class ServiceStatus:
    state: str  # running, stopped, starting, stopping, not installed, unknown, unavailable
    pid: int | None = None

    @property
    def installed(self) -> bool:
        return self.state not in ("not installed", "unavailable")


_SC_STATES = {
    "RUNNING": "running",
    "STOPPED": "stopped",
    "START_PENDING": "starting",
    "STOP_PENDING": "stopping",
}


def parse_service_status(sc_output: str) -> ServiceStatus:
    """Read `sc.exe queryex` output. sc prints the state names in English on
    every Windows locale, which is why it is parsed instead of Get-Service."""
    state = "unknown"
    match = re.search(r"STATE\s*:\s*\d+\s+(\w+)", sc_output)
    if match:
        state = _SC_STATES.get(match.group(1), "unknown")
    pid_match = re.search(r"^\s*PID\s*:\s*(\d+)", sc_output, re.MULTILINE)
    pid = int(pid_match.group(1)) if pid_match else 0
    return ServiceStatus(state, pid or None)


def query_service(runner: Runner | None = None) -> ServiceStatus:
    if not is_windows():
        return ServiceStatus("unavailable")
    code, output = (runner or run)(["sc.exe", "queryex", SERVICE_NAME])
    if code != 0:
        # 1060: the service does not exist. Anything else, we cannot tell.
        return ServiceStatus("not installed" if code == 1060 or "1060" in output else "unknown")
    return parse_service_status(output)


def listening_pids(netstat_output: str, port: str) -> set[int]:
    """PIDs listening on TCP `port`, from `netstat -ano`, IPv4 and IPv6."""
    pids: set[int] = set()
    suffix = f":{port}"
    for line in netstat_output.splitlines():
        fields = line.split()
        if len(fields) != 5 or fields[0].upper() != "TCP" or fields[3].upper() != "LISTENING":
            continue
        if fields[1].endswith(suffix) and fields[4].isdigit():
            pids.add(int(fields[4]))
    return pids


def service_owns_port(status: ServiceStatus, port: str, runner: Runner | None = None) -> bool:
    """Whether the installed service is the process listening on `port`.

    The service runs uvicorn in its own process (winservice.py), so its PID is
    the listener's PID. Compared by PID rather than by reading the service's
    port from config.json, which older installs did not let this process read.
    """
    if status.state != "running" or status.pid is None:
        return False
    code, output = (runner or run)(["netstat.exe", "-ano"])
    return code == 0 and status.pid in listening_pids(output, port)


def control_service(action: str, runner: Runner | None = None) -> None:
    """Start, stop or restart the installed service behind one UAC prompt."""
    cmdlet = SERVICE_ACTIONS[action]
    run_elevated(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", f"{cmdlet} -Name {_ps_quote(SERVICE_NAME)} -ErrorAction Stop"],
        wait=True,
        runner=runner,
    )


def service_action_message(action: str, error: Exception | None) -> str:
    """What to tell the operator after `control_service`."""
    label = {"start": "Start", "stop": "Stop", "restart": "Restart"}[action]
    if error is None:
        done = {"start": "started", "stop": "stopped", "restart": "restarted"}[action]
        return f"Installed service {SERVICE_NAME} {done}."
    if isinstance(error, ElevationDeclined):
        return (
            f"{label} service cancelled: administrator approval was declined. "
            f"Controlling the {SERVICE_NAME} service needs administrator rights."
        )
    return f"{label} service failed: {error}"


# ---------------------------------------------------------------------------
# config.json
# ---------------------------------------------------------------------------


def _editable_here(path: Path) -> bool:
    """True when this process can write `path`, creating it if missing.

    Raises PermissionError when it cannot: that is the protected installed
    config, which needs the elevated editor.
    """
    if path.exists():
        with path.open("r+", encoding="utf-8"):
            return True
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}\n", encoding="utf-8")
    return True


def open_config(path: Path, open_path: Callable[[Path], None], runner: Runner | None = None) -> str | None:
    """Open config.json for editing. Returns None on success, else what went wrong.

    A config this process can write opens with the normal handler. The
    installed one only administrators may change, so it opens in Notepad
    behind a UAC prompt, as the installer's "Open Whisper
    Config" shortcut does. Failures are returned, never swallowed: a button
    that silently does nothing is what this replaced.
    """
    try:
        _editable_here(path)
    except PermissionError:
        if not is_windows():
            return f"Cannot open {path}: permission denied."
        try:
            run_elevated("notepad.exe", [f'"{path}"'], wait=False, runner=runner)
        except ElevationDeclined:
            return f"Open config cancelled: administrator approval was declined. Only administrators can change {path}."
        except ElevatedActionFailed as exc:
            return f"Could not open {path} as administrator: {exc}"
        return None
    except OSError as exc:
        return f"Cannot open {path}: {exc}"
    try:
        open_path(path)
    except Exception as exc:
        return f"Could not open {path}: {exc}"
    return None
