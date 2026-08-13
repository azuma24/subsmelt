"""Where the server's file logging ended up, and whether it actually worked.

``run_server.configure_file_logging`` deliberately never fails startup: if the
log file cannot be opened it warns and carries on with console logging. That is
the right call, but on Windows the warning goes nowhere — a service has no
console, and the GUI launches the server with CREATE_NO_WINDOW and does not
capture stderr. The result was the worst of both worlds: no log file *and* no
indication why, which reads as "logging is broken".

run_server configures logging before uvicorn imports ``app.main``, in the same
process, so a module-level record is enough to carry the outcome across to
``/health``. Nothing here raises: this is diagnostics, and diagnostics must not
be able to take the server down.
"""

from __future__ import annotations

from typing import Any

_state: dict[str, Any] = {
    # Resolved log path, or None when file logging was never requested.
    "file": None,
    # True only when a handler is attached and writing.
    "active": False,
    # Why it is not active, when that is knowable (e.g. PermissionError).
    "error": None,
}


def set_log_state(file: str | None, active: bool, error: str | None = None) -> None:
    _state["file"] = file
    _state["active"] = bool(active)
    _state["error"] = error


def get_log_state() -> dict[str, Any]:
    """Snapshot for /health. Copied so callers cannot mutate the record."""
    return dict(_state)


def log_file_path() -> str | None:
    return _state.get("file")
