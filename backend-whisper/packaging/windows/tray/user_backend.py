#!/usr/bin/env python3
"""Start and stop the per-user Windows backend, with no administrator rights.

The backend is run_server.exe running as the signed-in user, detached from
whatever started it: the tray at login, or the control window. Because the
process is the user's own, the user may end it; nothing here needs UAC. The
backend is found by the port it listens on, and only a run_server.exe there
counts, so Stop never ends another program that took the port.

Kept free of tkinter and pystray so it can be tested anywhere.
"""

from __future__ import annotations

import csv
import io
import subprocess
import time

from windows_admin import CREATE_NO_WINDOW, Runner, listening_pids, run

CREATE_NEW_PROCESS_GROUP = 0x00000200
SERVER_IMAGE = "run_server.exe"
# How long Stop waits for the port to come free, so a Start right after it
# (Restart) does not race the old process for the port.
STOP_WAIT_SECONDS = 10.0


def image_name(pid: int, runner: Runner | None = None) -> str | None:
    """The executable name of process ``pid``, or None when it is gone."""
    code, output = (runner or run)(["tasklist.exe", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"])
    if code != 0:
        return None
    for row in csv.reader(io.StringIO(output)):
        if len(row) >= 2 and row[1].strip() == str(pid):
            return row[0].strip()
    return None


def _all_listening_pids(netstat_output: str) -> set[int]:
    pids: set[int] = set()
    for line in netstat_output.splitlines():
        fields = line.split()
        if len(fields) == 5 and fields[0].upper() == "TCP" and fields[3].upper() == "LISTENING" and fields[4].isdigit():
            pids.add(int(fields[4]))
    return pids


def backend_pid(port: str | None, runner: Runner | None = None) -> int | None:
    """The run_server.exe listening on ``port`` (any port when None), or None."""
    code, output = (runner or run)(["netstat.exe", "-ano"])
    if code != 0:
        return None
    pids = _all_listening_pids(output) if port is None else listening_pids(output, str(port))
    for pid in sorted(pids):
        if (image_name(pid, runner) or "").lower() == SERVER_IMAGE:
            return pid
    return None


def start_backend(command: list[str], popen=subprocess.Popen):
    """Launch the backend detached and windowless; it outlives its starter.

    It reads its host, port and key from the user's settings, so whatever
    starts it (tray or window) gets the same server.
    """
    return popen(
        command,
        creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
        close_fds=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def stop_backend(port: str | None, runner: Runner | None = None, wait_seconds: float = STOP_WAIT_SECONDS) -> str:
    """End the backend on ``port`` (any port when None) and wait for it to go."""
    pid = backend_pid(port, runner)
    if pid is None:
        return "not running"
    code, output = (runner or run)(["taskkill.exe", "/PID", str(pid), "/T", "/F"])
    if code != 0:
        return f"could not stop it: {output.strip().splitlines()[-1] if output.strip() else f'exit code {code}'}"
    deadline = time.monotonic() + wait_seconds
    while backend_pid(port, runner) is not None and time.monotonic() < deadline:
        time.sleep(0.25)
    return "stopped"


class UserBackendController:
    """The control window's Start/Stop for the per-user backend.

    Same shape as the window's ServerController, but the server it starts is
    detached and outlives the window, and Stop finds it by the run_server.exe
    listening on any port: after a port change the old one still holds the old
    port. A user runs one backend.
    """

    STARTUP_GRACE_SECONDS = 2.0

    def __init__(self, command_of, log_file_of, runner: Runner | None = None, popen=subprocess.Popen) -> None:
        self._command_of = command_of
        self._log_file_of = log_file_of
        self._runner = runner
        self._popen = popen
        # The process this window started, until it is listening: a backend
        # still probing CUDA is running but not yet on a port.
        self._proc = None

    @property
    def log_file(self):
        return self._log_file_of()

    def running(self) -> bool:
        if self._proc is not None and self._proc.poll() is None:
            return True
        return backend_pid(None, self._runner) is not None

    def start(self, host: str, port: str, token: str) -> str:
        if self.running():
            return "already running"
        try:
            command = self._command_of()
        except Exception as exc:  # ServerExecutableNotFound explains where it looked
            return f"failed to start: {exc}"
        try:
            self._proc = start_backend(command, popen=self._popen)
        except OSError as exc:  # pragma: no cover - environment dependent
            return f"failed to start: {command[0]}: {exc}"
        try:
            exit_code = self._proc.wait(timeout=self.STARTUP_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            return f"started on http://{host}:{port}"
        self._proc = None
        return (
            f"failed to start: the server exited immediately (code {exit_code}). "
            f"Port {port} may be in use by another program; see the log."
        )

    def stop(self) -> str:
        # A backend this window started may still be probing CUDA with no port
        # yet: its handle is the only way to find it, so end it first.
        proc, self._proc = self._proc, None
        if proc is not None and proc.poll() is None:
            (self._runner or run)(["taskkill.exe", "/PID", str(proc.pid), "/T", "/F"])
            try:
                proc.wait(timeout=STOP_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                pass
            result = stop_backend(None, self._runner)
            return "stopped" if result == "not running" else result
        return stop_backend(None, self._runner)
