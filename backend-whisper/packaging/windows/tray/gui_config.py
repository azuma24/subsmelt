#!/usr/bin/env python3
"""Persistence and safety messaging for the Whisper control window.

The GUI used to keep host/port/token in Tk variables only: every restart began
from the defaults, and the values were passed to the child process purely as
environment variables. Meanwhile run_server reads
``%SUBSMELT_DATA_DIR%\\config.json`` on every start (including the installed
Windows service), so writing that file is what makes a setting stick and apply
to the service as well as to a GUI-launched child.

Kept free of tkinter so it can be tested anywhere.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

DEFAULT_HOST = "0.0.0.0"
LOOPBACK_HOST = "127.0.0.1"
DEFAULT_PORT = "8001"

# Keys this window owns. Anything else in config.json is left untouched — the
# file is shared with the service and hand-editable, so a GUI save must not
# discard settings it does not know about.
OWNED_KEYS = ("host", "port", "token")


def data_dir(env: dict[str, str] | None = None) -> Path:
    environ = os.environ if env is None else env
    override = (environ.get("SUBSMELT_DATA_DIR") or "").strip()
    return Path(override) if override else Path(r"C:\ProgramData\SubSmelt")


def config_path(env: dict[str, str] | None = None) -> Path:
    """The config file the SERVER will actually read.

    run_server honours SUBSMELT_WHISPER_CONFIG ahead of the data directory, so
    the window has to resolve it the same way — otherwise, in that supported
    setup, it would sit editing a file the server never opens.
    """
    environ = os.environ if env is None else env
    explicit = (environ.get("SUBSMELT_WHISPER_CONFIG") or "").strip()
    if explicit:
        return Path(explicit)
    return data_dir(environ) / "config.json"


# run_server gives environment variables precedence over config.json, and
# install-service.ps1 sets these machine-wide for the installed service. When one
# is present, saving the corresponding field here cannot change what the service
# uses — say so rather than implying the setting took effect everywhere.
SHADOWING_ENV_VARS = {
    "host": "SUBSMELT_WHISPER_HOST",
    "port": "SUBSMELT_WHISPER_PORT",
    "token": "SUBSMELT_WHISPER_TOKEN",
}


def shadowed_by_env(env: dict[str, str] | None = None) -> list[str]:
    """Environment variables that will override the saved config, if any."""
    environ = os.environ if env is None else env
    return [
        name for name in SHADOWING_ENV_VARS.values()
        if (environ.get(name) or "").strip()
    ]


def shadowed_note(names: list[str]) -> str | None:
    """Explanation for settings that cannot reach the installed service."""
    if not names:
        return None
    joined = ", ".join(sorted(names))
    return (
        f"Saved, but {joined} is set in the machine environment and takes "
        "precedence over config.json. The installed service will keep using that "
        "value; this window's own runs use the fields above."
    )


def load_config(path: Path) -> dict[str, str]:
    """Read saved host/port/token, falling back to defaults.

    Never raises: a missing, unreadable or malformed config must leave the window
    usable rather than refusing to open.
    """
    values = {"host": DEFAULT_HOST, "port": DEFAULT_PORT, "token": ""}
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return values
    if not isinstance(raw, dict):
        return values
    for key in OWNED_KEYS:
        value = raw.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            values[key] = str(value).strip()
    return values


def save_config(path: Path, host: str, port: str, token: str) -> None:
    """Merge host/port/token into config.json, preserving every other key."""
    target = Path(path)
    existing: dict = {}
    try:
        loaded = json.loads(target.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            existing = loaded
    except (OSError, json.JSONDecodeError):
        existing = {}

    existing["host"] = host
    existing["port"] = str(port)
    if token.strip():
        existing["token"] = token.strip()
    else:
        # Clearing the field must actually clear the stored secret, not leave a
        # stale token quietly enforcing auth.
        existing.pop("token", None)

    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
    tmp.replace(target)


#: backend-whisper/ — app/token_gen.py is the single definition of how strong a
#: generated key is, and duplicating it here to avoid one import is exactly how
#: the two would drift apart. Mirrors whisper_gui.py's path handling for
#: app.version; the frozen build gets it via the spec's pathex + hiddenimports.
_BACKEND_ROOT = str(Path(__file__).resolve().parents[3])


def generate_token() -> str:
    """Mint a fresh backend API key for the operator to copy into SubSmelt.

    Imported lazily so a bundle missing ``app.token_gen`` still opens the
    control window — the operator loses the Generate button, not the app. The
    caller is expected to surface the ImportError rather than fall back to a
    home-made secret: a weak token that looks generated is worse than none.
    """
    if _BACKEND_ROOT not in sys.path:
        sys.path.insert(0, _BACKEND_ROOT)
    from app.token_gen import generate_token as _generate

    return _generate()


def bind_warning(host: str, token: str) -> str | None:
    """Warning to show when the server is reachable off-box without a token."""
    if host == LOOPBACK_HOST or token.strip():
        return None
    return (
        f"Listening on {host} with no token — every host on this network can use "
        "this backend. Set a token, or bind 127.0.0.1."
    )
