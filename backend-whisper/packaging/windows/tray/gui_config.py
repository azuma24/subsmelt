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


DEFAULT_WINDOWS_DATA_DIR = r"C:\ProgramData\SubSmelt"


def data_dir(env: dict[str, str] | None = None, platform: str | None = None) -> Path:
    """Where config.json and logs/ live: SUBSMELT_DATA_DIR, else the platform's
    application-data directory.

    Mirrors run_server.default_data_dir. The server and the control apps are
    frozen into separate exes, so the function cannot be shared; test_gui_config
    pins the two copies together.
    """
    environ = os.environ if env is None else env
    override = (environ.get("SUBSMELT_DATA_DIR") or "").strip()
    if override:
        return Path(override)
    if platform is None:
        platform = sys.platform
    if platform == "win32":
        return Path(DEFAULT_WINDOWS_DATA_DIR)
    if platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "SubSmelt"
    xdg = (environ.get("XDG_DATA_HOME") or "").strip()
    return (Path(xdg) if xdg else Path.home() / ".local" / "share") / "subsmelt"


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


# run_server gives environment variables precedence over config.json. Older
# installers set these machine-wide for the installed service (the current one
# removes them), and a shell may still export them. When one is present, saving
# the corresponding field here cannot change what the service uses — say so
# rather than implying the setting took effect everywhere.
SHADOWING_ENV_VARS = {
    "host": "SUBSMELT_WHISPER_HOST",
    "port": "SUBSMELT_WHISPER_PORT",
    "token": "SUBSMELT_WHISPER_TOKEN",
}


def shadowed_by_env(env: dict[str, str] | None = None) -> list[str]:
    """Environment variables that will override the saved config, if any."""
    environ = os.environ if env is None else env
    return [name for name in SHADOWING_ENV_VARS.values() if (environ.get(name) or "").strip()]


def effective_config(env: dict[str, str] | None = None) -> dict[str, str]:
    """host/port/token as run_server will resolve them: env, then config.json,
    then the defaults. What a "open the health page" link has to use."""
    environ = os.environ if env is None else env
    values = load_config(config_path(environ))
    for key, name in SHADOWING_ENV_VARS.items():
        override = (environ.get(name) or "").strip()
        if override:
            values[key] = override
    return values


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


def source_backend_root(module_file: str = __file__) -> Path | None:
    """backend-whisper/ of a source checkout, three levels above tray/.

    None in a frozen build, where the bundle supplies app.* via the spec's
    pathex + hiddenimports and there is no checkout to find. Also None when the
    path is too shallow to climb: a onefile exe extracts to %TEMP%, and under a
    short TEMP ``parents[3]`` raised IndexError at import time, so the tray and
    the GUI never started.
    """
    if getattr(sys, "frozen", False):
        return None
    parents = Path(module_file).resolve().parents
    return parents[3] if len(parents) > 3 else None


def dev_server_script(module_file: str = __file__) -> Path | None:
    """The repo's own run_server.py, for launching the server unfrozen."""
    root = source_backend_root(module_file)
    return root / "run_server.py" if root else None


def generate_token() -> str:
    """Mint a fresh backend API key for the operator to copy into SubSmelt.

    app/token_gen.py is the single definition of how strong a generated key is;
    duplicating it here to avoid one import is exactly how the two would drift.
    Imported lazily so a bundle missing ``app.token_gen`` still opens the
    control window — the operator loses the Generate button, not the app. The
    caller is expected to surface the ImportError rather than fall back to a
    home-made secret: a weak token that looks generated is worse than none.
    """
    root = source_backend_root()
    if root and str(root) not in sys.path:
        sys.path.insert(0, str(root))
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
