#!/usr/bin/env python3
"""SubSmelt Whisper backend — native Windows GUI app (plan Phase 3, GUI variant).

A small Tkinter control window that OWNS a run_server.exe child process:
    * pick bind host (127.0.0.1 / 0.0.0.0) + port + optional token
    * Start / Stop / Restart the server
    * live status + a Refresh that reads /health (version, GPU, ffmpeg, models)
    * open the health page / logs / config
    * CLOSING the window HIDES it to the system tray (the server keeps running);
      a tray icon restores it or quits (Quit stops the server).

Native: Tkinter uses Win32 widgets and ships with CPython, so the frozen exe is
self-contained with no heavy GUI deps. The server's own console is hidden
(CREATE_NO_WINDOW); the child is given its own log file (whisper-server-gui.log
next to the service's log) and "View log" shows it.

Deps: pystray + pillow (tray) are tray-build-only; tkinter is stdlib. All three
imports are guarded so this file syntax-checks anywhere.
"""

from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import ttk

    _HAS_TK = True
except Exception:  # pragma: no cover - tk absent on some minimal builds
    tk = ttk = None  # type: ignore
    _HAS_TK = False

try:
    import pystray  # type: ignore
    from PIL import Image, ImageDraw  # type: ignore

    _HAS_TRAY = True
except Exception:  # pragma: no cover
    pystray = None  # type: ignore
    Image = ImageDraw = None  # type: ignore
    _HAS_TRAY = False

try:
    import windows_admin
    from gui_config import (
        ConfigUnreadable,
        bind_warning,
        config_path,
        data_dir,
        default_config,
        dev_server_script,
        effective_config,
        generate_token,
        load_config,
        read_only_config_note,
        save_config,
        settings_path,
        shadowed_by_env,
        shadowed_note,
        source_backend_root,
        unreadable_config_note,
    )
    from server_launch import ServerExecutableNotFound, resolve_server_command
    from user_backend import UserBackendController
except ImportError:  # pragma: no cover - this file's dir isn't on sys.path yet
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import windows_admin
    from gui_config import (
        ConfigUnreadable,
        bind_warning,
        config_path,
        data_dir,
        default_config,
        dev_server_script,
        effective_config,
        generate_token,
        load_config,
        read_only_config_note,
        save_config,
        settings_path,
        shadowed_by_env,
        shadowed_note,
        source_backend_root,
        unreadable_config_note,
    )
    from server_launch import ServerExecutableNotFound, resolve_server_command
    from user_backend import UserBackendController


def _resolve_app_version() -> str:
    """Version of this GUI build.

    Single source of truth is app/version.py, which the release bumps alongside
    package.json and the installer — deliberately not a fourth constant to keep
    in step. It is importable here because whisper-gui.spec puts backend-whisper
    on pathex and hidden-imports `app.version` (app/__init__.py is empty, so
    this costs the bundle nothing). SUBSMELT_WHISPER_VERSION still wins; the
    installer stamps the version into config.json for the service.

    Never fatal: a control window that cannot start because it failed to work
    out its own version number would be a poor trade.
    """
    env = (os.environ.get("SUBSMELT_WHISPER_VERSION") or "").strip()
    if env:
        return env
    try:
        from app.version import backend_version  # type: ignore

        return backend_version()
    except Exception:
        try:
            root = source_backend_root()
            if root:
                sys.path.insert(0, str(root))
            from app.version import backend_version  # type: ignore

            return backend_version()
        except Exception:
            return "unknown"


APP_VERSION = _resolve_app_version()
# Matches run_server.DEFAULT_LOG_FILE_NAME. Kept as a literal rather than
# imported so the log viewer still works if app/ is unavailable for any reason.
DEFAULT_LOG_FILE_NAME = "whisper-server.log"
# The child this window launches logs here, beside the service's log, so the
# two never interleave in one file.
GUI_LOG_FILE_NAME = "whisper-server-gui.log"
LOG_TAIL_LINES = 500
#: Character the API key field masks with. A single glyph rather than the real
#: value, so the window is safe to leave open on a shared screen.
TOKEN_MASK_CHAR = "•"
#: Where the generated key goes on the SubSmelt side. Spelled out in full — the
#: operator has just been handed a secret and should not have to go looking.
PASTE_LOCATION = "SubSmelt → Settings → Speech to Text → Backend token"
#: Read only the tail off disk — the handler rotates at 5 MB and the viewer
#: only ever shows the end.
LOG_TAIL_MAX_BYTES = 512 * 1024


def log_dir() -> Path:
    return data_dir() / "logs"


def resolve_log_file() -> Path:
    """Where the installed service logs, using run_server's own precedence.

    run_server picks SUBSMELT_WHISPER_LOG_FILE, then the ``log_file`` key in
    config.json, then <data dir>/logs/whisper-server.log. The viewer has to
    follow the same order — otherwise, in either supported override, it reports
    "no log file" while the real log sits somewhere else. Same reasoning as
    gui_config.config_path, which already resolves the config file this way.

    Reads the JSON directly rather than via gui_config.load_config, which
    intentionally returns only host/port/token. Never raises: an unreadable or
    malformed config falls back to the default path.
    """
    env = (os.environ.get("SUBSMELT_WHISPER_LOG_FILE") or "").strip()
    if env:
        return Path(env)
    try:
        import json

        raw = json.loads(Path(config_path()).read_text(encoding="utf-8"))
        value = str((raw or {}).get("log_file") or "").strip() if isinstance(raw, dict) else ""
        if value:
            return Path(value)
    except Exception:
        pass  # missing/unreadable/malformed config — fall through to the default
    return log_dir() / DEFAULT_LOG_FILE_NAME


def user_log_dir() -> Path:
    """A log folder this user can always write: %LOCALAPPDATA%\\SubSmelt\\logs."""
    local = (os.environ.get("LOCALAPPDATA") or "").strip()
    base = Path(local) / "SubSmelt" if local else Path.home() / ".cache" / "subsmelt"
    return base / "logs"


def _can_append(path: Path) -> bool:
    """Open for append as the real test: os.access ignores Windows ACLs."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8"):
            return True
    except OSError:
        return False


def gui_log_file() -> Path:
    """The log file for a server this window launches: next to the service's
    log, under its own name. Sharing the service's file meant both wrote into
    it and "View log" showed whichever server spoke last.

    The installer locks the data folder to administrators, so the unelevated
    window usually cannot write there; its server then logged nothing at all.
    In that case the log goes to the user's own folder instead.
    """
    beside_service = resolve_log_file().with_name(GUI_LOG_FILE_NAME)
    if _can_append(beside_service):
        return beside_service
    return user_log_dir() / GUI_LOG_FILE_NAME


def read_log_tail(path: Path, lines: int) -> tuple[list[str], str]:
    """Last `lines` of `path`, plus a human note about what was read.

    Returns ([], reason) rather than raising: "there is no log" is a normal
    state here (logging off, nothing written yet, or the file is owned by the
    service account and unreadable), and the viewer should say which.
    """
    try:
        if not path.exists():
            return [], f"No log file at {path} — the server may not have run yet."
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > LOG_TAIL_MAX_BYTES:
                fh.seek(size - LOG_TAIL_MAX_BYTES)
                fh.readline()  # drop the partial line the seek landed inside
            raw = fh.read()
        tail = raw.decode("utf-8", errors="replace").splitlines()[-lines:]
        if not tail:
            return [], f"{path} is empty."
        note = f"last {len(tail)} lines of {path}"
        if size > LOG_TAIL_MAX_BYTES:
            note += " (older lines truncated)"
        return tail, note
    except OSError as exc:
        return [], f"Could not read {path}: {exc}"


CREATE_NO_WINDOW = 0x08000000  # Windows: don't open a console for the child


# ---------------------------------------------------------------------------
# Server child-process control
# ---------------------------------------------------------------------------


class ServerController:
    """Owns the run_server.exe child process with the chosen host/port/token."""

    # A server that cannot bind (port already taken by the installed service, a
    # bad model dir) exits within a moment of launching. Popen returning only
    # means the process was created, so wait briefly and check before reporting
    # success — otherwise the window says "started" about a process that is gone.
    STARTUP_GRACE_SECONDS = 2.0

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        # Where the most recent child was told to log. Kept after it stops so
        # "View log" can still show why it died.
        self.log_file: Path | None = None

    @staticmethod
    def _command() -> list[str]:
        return resolve_server_command(dev_server_script())

    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self, host: str, port: str, token: str) -> str:
        if self.running():
            return "already running"
        env = dict(os.environ)
        env["SUBSMELT_WHISPER_HOST"] = host
        env["SUBSMELT_WHISPER_PORT"] = port
        if token.strip():
            env["SUBSMELT_WHISPER_TOKEN"] = token.strip()
        else:
            env.pop("SUBSMELT_WHISPER_TOKEN", None)
        # Always set, overriding a machine-wide SUBSMELT_WHISPER_LOG_FILE: that
        # one belongs to the installed service, and the child must not share it.
        self.log_file = gui_log_file()
        env["SUBSMELT_WHISPER_LOG_FILE"] = str(self.log_file)
        flags = CREATE_NO_WINDOW if os.name == "nt" else 0
        # Resolve first: a missing server exe gets a path-by-path explanation
        # instead of a bare "[WinError 2] The system cannot find the file specified".
        try:
            command = self._command()
        except ServerExecutableNotFound as exc:
            return f"failed to start: {exc}"
        try:
            self._proc = subprocess.Popen(command, env=env, creationflags=flags)
        except Exception as exc:  # pragma: no cover - environment dependent
            return f"failed to start: {command[0]}: {exc}"

        try:
            exit_code = self._proc.wait(timeout=self.STARTUP_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            # Still alive after the grace period: as good a signal as we get
            # without polling /health, which the caller does next anyway.
            return f"started on http://{host}:{port}"

        self._proc = None
        return (
            f"failed to start: the server exited immediately (code {exit_code}). "
            f"Port {port} may already be in use by the installed service — "
            "check the log in the data directory."
        )

    def stop(self) -> str:
        if not self.running():
            self._proc = None
            return "not running"
        proc = self._proc
        try:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
            return "stopped"
        finally:
            self._proc = None


class ThreadMessages:
    """Status text handed from a worker thread to the Tk thread.

    Tkinter's ``after()`` is not the escape hatch it looks like: called from a
    thread other than the interpreter's own, it queues into that thread's Tcl
    apartment and the main loop never services it. No exception is raised, so
    the readiness poller's messages simply vanished. A plain queue plus a timer
    on the Tk side is the only arrangement that actually delivers.

    Only the newest message survives a collection — each one is a full
    replacement for the info panel, so showing a backlog would rewind what the
    operator is being told.

    Messages are stamped with the launch generation that produced them. A
    readiness poll runs for up to 45s, so Stop or Restart can happen while one
    is still in flight; without the stamp its "Start failed" lands on top of the
    operator's explicit "Stop: stopped", and after a Restart it can report on
    the previous host and port over the new launch's result.
    """

    def __init__(self) -> None:
        self._queue: queue.Queue[tuple[int, str]] = queue.Queue()

    def post(self, text: str, generation: int = 0) -> None:
        """Called from any thread."""
        self._queue.put((generation, text))

    def latest(self, generation: int = 0) -> str | None:
        """Newest pending message for `generation`, or None.

        Called from the Tk thread. Messages from superseded launches are
        discarded rather than displayed, and discarding one must not consume a
        live message queued behind it.
        """
        text: str | None = None
        while True:
            try:
                stamp, candidate = self._queue.get_nowait()
            except queue.Empty:
                return text
            if stamp == generation:
                text = candidate


def port_conflict_message(host: str, port: str) -> str:
    """Explanation for a Start into a port something else already serves.

    Worth refusing rather than launching and failing: run_server probes CUDA
    before it binds, so a child that is doomed by a port conflict can outlive
    the two-second startup grace and look like a success. Meanwhile /health on
    that port is answered by the incumbent, so the readiness poll would confirm
    a server this window does not own.
    """
    return (
        f"Not started: something is already serving http://{host}:{port}.\n\n"
        "Another program holds that port, such as a backend started from a "
        "command line. Stop it first, or choose a different port — starting now would fail to bind, "
        "and the health check would be answered by the other server.\n\n"
        "If that other server IS the one you want, point SubSmelt at it and "
        "leave this window's server stopped."
    )


def service_label(status: windows_admin.ServiceStatus, owns_port: bool, port: str) -> str:
    """The installed-service line under the status line."""
    service = windows_admin.SERVICE_NAME
    if status.state == "unavailable":
        return "Installed service: not available on this platform"
    if status.state == "not installed":
        return f"Installed service: {service} is not installed"
    label = f"Installed service: {service} {status.state}"
    if owns_port:
        label += f", serving port {port}"
    return label


def _launchd():
    """macos/service_control.py: bundled beside this module when frozen, two
    folders up in a source checkout."""
    try:
        import service_control
    except ImportError:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "macos"))
        import service_control
    return service_control


def query_installed_service() -> windows_admin.ServiceStatus:
    """The backend the installer set up: the Windows service, or on macOS the
    LaunchAgent. "unavailable" elsewhere."""
    if sys.platform == "darwin":
        return windows_admin.ServiceStatus(_launchd().service_status())
    return windows_admin.query_service()


def control_installed_service(action: str) -> None:
    """Start, stop or restart it. Windows asks for administrator approval; the
    LaunchAgent belongs to the user and needs none. Raises the windows_admin
    errors either way, so one message function covers both."""
    if sys.platform != "darwin":
        windows_admin.control_service(action)
        return
    launchd = _launchd()
    run = {"start": launchd.start_service, "stop": launchd.stop_service, "restart": launchd.restart_service}[action]
    code, output = run()
    if code != 0:
        lines = output.strip().splitlines()
        raise windows_admin.ElevatedActionFailed(f"exit code {code}" + (f": {lines[-1]}" if lines else ""))


def prepare_windows_user_data() -> None:
    """Carry an old service install's key over (or mint one) before the window
    reads its settings, so a first Start never saves an empty key over it.
    Shares run_server's own code; a no-op off Windows or with a custom data dir."""
    try:
        import run_server  # type: ignore
    except ImportError:
        root = source_backend_root()
        if not root:
            return
        sys.path.insert(0, str(root))
        import run_server  # type: ignore
    if run_server.windows_user_data_needs_preparing():
        run_server.prepare_user_data(run_server.default_data_dir(), Path(run_server.LEGACY_WINDOWS_DATA_DIR))


def make_controller():
    """The Windows backend runs as the user, detached; elsewhere the window owns a child."""
    if os.name == "nt":
        return UserBackendController(
            command_of=lambda: resolve_server_command(dev_server_script()),
            log_file_of=resolve_log_file,
        )
    return ServerController()


def drives_service(status: windows_admin.ServiceStatus) -> bool:
    """Whether Start / Stop / Restart act on the installed service.

    Setup registers the backend as a service (on macOS, a LaunchAgent) on the
    port it asked for. A second
    server launched from this window could never bind that port, so with the
    service installed the window controls the service instead of a child.
    """
    return status.installed


_SERVICE_STATES = {
    "stopped": "○ Stopped (service)",
    "starting": "◐ Service starting…",
    "stopping": "◐ Service stopping…",
}


def service_status_label(status: windows_admin.ServiceStatus, serving_port: str | None) -> str:
    """The status line while the window drives the service.

    `serving_port` is the port the service was seen listening on, or None when
    that is unknown; a port read from the form could be one it does not serve.
    """
    if status.state == "running":
        return f"● Running as a service on port {serving_port}" if serving_port else "● Running as a service"
    return _SERVICE_STATES.get(status.state, f"? Service {status.state}")


def launched_settings(
    previous: tuple[str, str, str] | None,
    was_running: bool,
    is_running: bool,
    current: tuple[str, str, str],
) -> tuple[str, str, str] | None:
    """Which settings the running child was actually launched with.

    Pulled out of the window because the "already running" case is easy to get
    wrong: ``ServerController.start`` is a no-op when a child is already up, so
    the form values were never applied to anything and adopting them would make
    the status line describe a server that does not exist.
    """
    if not is_running:
        return None  # nothing to describe; a dead process owns no settings
    if was_running:
        return previous  # start() did not launch this — the earlier one still owns it
    return current


def status_label(
    running: bool,
    active: tuple[str, str, str] | None,
    current: tuple[str, str, str],
) -> str:
    """The status line for a process state, its launch settings, and the form.

    Describes the PROCESS, never the form. The fields stay editable while the
    server runs, so a label built from them would claim a port nothing is bound
    to and would drop the no-token warning the moment someone typed a token they
    had not applied yet.
    """
    if not running:
        return "○ Stopped"
    if not active:
        return "● Running"  # launched before this window, or by someone else
    host, port, token = active
    label = f"● Running on {host}:{port}"
    if bind_warning(host, token):
        label += "  ⚠ no token"
    if active != current:
        label += "  (restart to apply edits)"
    return label


def health_url(host: str, port: str) -> str:
    """A wide bind is reached over loopback; anything else is used as given."""
    url_host = "127.0.0.1" if host == "0.0.0.0" else host
    return f"http://{url_host}:{port}/health"


def fetch_health(host: str, port: str, token: str) -> dict | None:
    """GET /health (open route). Returns parsed JSON or None on failure."""
    import json

    req = urllib.request.Request(health_url(host, port))
    if token.strip():
        req.add_header("Authorization", f"Bearer {token.strip()}")
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Tkinter window
# ---------------------------------------------------------------------------


def _icon_image(running: bool):
    img = Image.new("RGB", (64, 64), color=(28, 28, 30))
    draw = ImageDraw.Draw(img)
    draw.ellipse((16, 16, 48, 48), fill=(46, 204, 113) if running else (120, 120, 120))
    return img


class WhisperGuiApp:
    # How often the window re-checks whether the server is still alive. Without
    # this the status only changed on a button press, so a crashed backend kept
    # showing "Running" indefinitely.
    STATUS_POLL_MS = 3_000

    # Readiness is confirmed by /health, not by the process merely surviving:
    # CUDA probing and importing app.main can outlast any fixed grace period, so
    # a bind failure may arrive after the process looks alive.
    READY_TIMEOUT_SECONDS = 45
    READY_POLL_SECONDS = 1.0

    # How often the Tk thread collects text left by the readiness poller. Well
    # under READY_POLL_SECONDS so "Ready" lands as soon as it is known.
    MESSAGE_POLL_MS = 250

    def __init__(self) -> None:
        prepare_windows_user_data()
        self.ctl = make_controller()
        self.config_file = config_path()
        # Settings the RUNNING child was launched with. The form fields can be
        # edited while it runs, and the status line must describe the process,
        # not whatever is currently typed.
        self.active: tuple[str, str, str] | None = None
        # The installed service, when there is one, is the backend the buttons
        # control (see drives_service). Read by _refresh_service.
        self.service = windows_admin.ServiceStatus("unavailable")
        # The port the service was last seen listening on, else None.
        self.service_port: str | None = None
        # Worker threads cannot touch Tk, so they leave text here instead.
        self._messages = ThreadMessages()
        # Bumped on every Start and Stop. A readiness poll runs for up to 45s,
        # so one can outlive the launch it was watching; its messages are
        # stamped with the generation and dropped once superseded.
        self._generation = 0
        # An unreadable config.json (an older install's, which only
        # administrators can read) must not pass for an empty one; see
        # gui_config.ConfigUnreadable.
        self.config_error: ConfigUnreadable | None = None
        try:
            self.saved = load_config(self.config_file)
        except ConfigUnreadable as exc:
            self.config_error = exc
            self.saved = default_config()
        self.root = tk.Tk()
        # Version in the title so a bug report names the build without the
        # server having to be running (the /health readout only covers the
        # server, and only after a Refresh).
        self.root.title(f"SubSmelt Whisper Backend {APP_VERSION}")
        self.root.geometry("560x600")
        self._tray_icon = None
        self._build_ui()
        # Close button hides to tray instead of quitting.
        self.root.protocol("WM_DELETE_WINDOW", self.hide_to_tray)
        self._poll_status()
        self._refresh_service()
        self._drain_messages()
        if self.config_error is not None:
            self._set_info(unreadable_config_note(self.config_error))

    # ---- UI ----
    def _build_ui(self) -> None:
        pad = {"padx": 10, "pady": 4}
        frm = ttk.Frame(self.root)
        frm.pack(fill="both", expand=True, padx=12, pady=12)

        self.status_var = tk.StringVar(value="○ Stopped")
        ttk.Label(frm, textvariable=self.status_var, font=("Segoe UI", 12, "bold")).grid(
            row=0, column=0, columnspan=3, sticky="w", **pad
        )

        # Host
        ttk.Label(frm, text="Bind address:").grid(row=1, column=0, sticky="w", **pad)
        # Prefilled from config.json (which run_server reads on every start), so
        # settings survive a restart of this window.
        self.host_var = tk.StringVar(value=self.saved["host"])
        ttk.Radiobutton(frm, text="127.0.0.1 (local only)", variable=self.host_var, value="127.0.0.1").grid(
            row=1, column=1, sticky="w"
        )
        ttk.Radiobutton(frm, text="0.0.0.0 (LAN/remote)", variable=self.host_var, value="0.0.0.0").grid(
            row=2, column=1, sticky="w"
        )

        # Port
        ttk.Label(frm, text="Port:").grid(row=3, column=0, sticky="w", **pad)
        self.port_var = tk.StringVar(value=self.saved["port"])
        ttk.Entry(frm, textvariable=self.port_var, width=10).grid(row=3, column=1, sticky="w")

        # Token / API key
        ttk.Label(frm, text="API key (token):").grid(row=4, column=0, sticky="w", **pad)
        self.token_var = tk.StringVar(value=self.saved["token"] or os.environ.get("SUBSMELT_WHISPER_TOKEN", ""))
        # Masked by default: this window is often on screen while screen-sharing
        # a "why won't it connect" call. Reveal is one button away.
        self.token_entry = ttk.Entry(frm, textvariable=self.token_var, width=28, show=TOKEN_MASK_CHAR)
        self.token_entry.grid(row=4, column=1, sticky="w")

        # Its own row rather than a third column: three buttons beside the entry
        # push past the window width and clip the last one.
        key_btns = ttk.Frame(frm)
        key_btns.grid(row=5, column=1, sticky="w", padx=10)
        ttk.Button(key_btns, text="Generate", command=self.on_generate_token).pack(side="left", padx=(0, 4))
        ttk.Button(key_btns, text="Copy", command=self.on_copy_token).pack(side="left", padx=4)
        self.reveal_btn = ttk.Button(key_btns, text="Show", command=self.toggle_token_visibility)
        self.reveal_btn.pack(side="left", padx=4)

        # Buttons
        btns = ttk.Frame(frm)
        btns.grid(row=6, column=0, columnspan=3, sticky="w", **pad)
        self.start_btn = ttk.Button(btns, text="Start", command=self.on_start)
        self.start_btn.pack(side="left", padx=4)
        self.stop_btn = ttk.Button(btns, text="Stop", command=self.on_stop)
        self.stop_btn.pack(side="left", padx=4)
        ttk.Button(btns, text="Restart", command=self.on_restart).pack(side="left", padx=4)
        ttk.Button(btns, text="Refresh", command=self.on_refresh).pack(side="left", padx=4)

        # Which server the buttons above control: the installed service when
        # there is one (each action behind a UAC prompt), else this window's own.
        self.service_var = tk.StringVar(value="Installed service: checking…")
        ttk.Label(frm, textvariable=self.service_var).grid(row=7, column=0, columnspan=3, sticky="w", **pad)

        links = ttk.Frame(frm)
        links.grid(row=9, column=0, columnspan=3, sticky="w", **pad)
        ttk.Button(links, text="Open health page", command=self.open_health).pack(side="left", padx=4)
        ttk.Button(links, text="View log", command=self.view_log).pack(side="left", padx=4)
        ttk.Button(links, text="Open logs", command=self.open_logs).pack(side="left", padx=4)
        ttk.Button(links, text="Open config", command=self.open_config).pack(side="left", padx=4)

        # Version is in the title bar too, but a maximised or screenshotted
        # window often loses that, and this is the line people quote in reports.
        ttk.Label(frm, text=f"GUI version {APP_VERSION}").grid(row=10, column=0, columnspan=3, sticky="w", **pad)

        # Info box (health output). Rows 11/12 — the version label above owns
        # row 10; sharing a cell would stack the two labels on top of each other.
        ttk.Label(frm, text="Server info:").grid(row=11, column=0, sticky="nw", **pad)
        self.info = tk.Text(frm, height=10, width=58, wrap="word", state="disabled", font=("Consolas", 9))
        self.info.grid(row=12, column=0, columnspan=3, sticky="nsew", padx=10, pady=6)
        frm.rowconfigure(12, weight=1)
        frm.columnconfigure(2, weight=1)

    def _set_info(self, text: str) -> None:
        self.info.config(state="normal")
        self.info.delete("1.0", "end")
        self.info.insert("1.0", text)
        self.info.config(state="disabled")

    # ---- actions ----
    def _save_settings(self, host: str, port: str, token: str) -> tuple[bool, str]:
        """Save host/port/token to settings.json; (saved, note for the info box).

        run_server reads it on every start, so saving BEFORE a start or restart
        is what makes the values shown here the ones the server uses.
        """
        try:
            save_config(self.config_file, host, port, token)
        except ConfigUnreadable as exc:
            # Nothing was written: the existing file (token included) is intact.
            return False, f"\n\nNot saved: {exc}. This run uses the fields above."
        except PermissionError:
            return False, f"\n\n{read_only_config_note(self.config_file)}"
        except OSError as exc:
            return False, f"\n\nCould not save {settings_path(self.config_file)}: {exc}"
        note = shadowed_note(shadowed_by_env())
        return True, f"\n\nNote: {note}" if note else ""

    def on_start(self) -> None:
        host, port, token = self.host_var.get(), self.port_var.get(), self.token_var.get()
        _saved, saved_note = self._save_settings(host, port, token)

        self._refresh_service(port)
        if drives_service(self.service):
            # A running service only reads settings.json when it starts.
            action = "restart" if self.service.state == "running" else "start"
            self.on_service(action, note=saved_note)
            return

        # start() is a no-op when a child is already up, so whether THIS call
        # launched anything is the difference between the form values describing
        # the running server and describing nothing at all.
        was_running = self.ctl.running()
        if was_running and isinstance(self.ctl, UserBackendController):
            # The backend reads its settings when it starts: Start applies them.
            self.ctl.stop()
            was_running = self.ctl.running()

        # Refuse to launch into a port something else already serves. run_server
        # probes CUDA before it binds, so a doomed child can outlive the startup
        # grace; meanwhile /health on that port is answered by the OTHER server,
        # and the readiness poll would report success for a process this window
        # does not own. (An installed service never gets here: Start drives it.)
        if not was_running and fetch_health(host, port, token) is not None:
            self._set_info(port_conflict_message(host, port) + saved_note)
            self._refresh_status()
            return
        msg = self.ctl.start(host, port, token)
        launched = self.ctl.running() and not was_running
        self.active = launched_settings(self.active, was_running, self.ctl.running(), (host, port, token))
        if launched:
            self._generation += 1

        warning = bind_warning(host, token)
        lines = [f"Start: {msg}"]
        if warning:
            lines.append(f"\nWARNING: {warning}")
        if launched:
            lines.append(
                f"\nWaiting for /health (up to {self.READY_TIMEOUT_SECONDS}s) — "
                "the first start loads models and probes CUDA."
            )
        self._set_info("".join(lines) + saved_note)
        self._refresh_status()

        if launched:
            # Surviving the grace period is not the same as serving: CUDA
            # probing and importing app.main can outlast any fixed wait, so a
            # bind failure can still arrive after the process looks alive.
            # Polled off the Tk thread so the window stays responsive.
            threading.Thread(
                target=self._await_ready,
                args=(host, port, token, self._generation),
                daemon=True,
            ).start()

    def _await_ready(self, host: str, port: str, token: str, generation: int) -> None:
        """Poll /health until the server answers or the process dies.

        `generation` identifies the launch this poll belongs to. Stop and
        Restart bump it, and anything this thread posts afterwards is dropped
        rather than overwriting the newer state.
        """
        deadline = self.READY_TIMEOUT_SECONDS
        while deadline > 0:
            if generation != self._generation:
                return  # superseded by a Stop or a later Start
            if not self.ctl.running():
                self._post_info_for(
                    generation,
                    f"Start failed: the server exited before answering /health.\n"
                    f"Port {port} may already be in use by the installed service — "
                    "check the log in the data directory.",
                )
                return
            if fetch_health(host, port, token) is not None:
                ready = [f"Ready: serving on http://{host}:{port}"]
                warning = bind_warning(host, token)
                if warning:
                    # Readiness must not read as an all-clear on a backend that
                    # is now genuinely open to the network.
                    ready.append(f"\nWARNING: {warning}")
                    ready.append("\nPress Generate next to the API key field to fix this.")
                self._post_info_for(generation, "".join(ready))
                return
            time.sleep(self.READY_POLL_SECONDS)
            deadline -= self.READY_POLL_SECONDS

        self._post_info_for(
            generation,
            f"Started, but /health did not answer within {self.READY_TIMEOUT_SECONDS}s. "
            "The process is alive — it may still be loading, or it may be wedged. "
            "Open the logs to check.",
        )

    def _post_info_for(self, generation: int, text: str) -> None:
        """Show `text` if `generation` is still the current launch.

        Safe to call from any thread; never touches Tk directly — see
        ThreadMessages for why ``after()`` is not usable from a worker.
        """
        self._messages.post(text, generation)

    def _drain_messages(self) -> None:
        """Collect anything the readiness poller left, on the Tk thread."""
        text = self._messages.latest(self._generation)
        if text is not None:
            self._set_info(text)
            self._refresh_status()
            self._refresh_service()
        self.root.after(self.MESSAGE_POLL_MS, self._drain_messages)

    # ---- API key ----
    def on_generate_token(self) -> None:
        """Mint a strong API key, copy it, save it and restart the backend.

        Exists because every hardening message the backend has ever shown ended
        at "set a token", which asks the operator to invent a secret — so they
        invent a weak one, or skip it and leave a 0.0.0.0 backend open to the
        network. The backend reads its key only when it starts, so a key that
        is not applied at once looks generated but never links up.
        """
        try:
            token = generate_token()
        except Exception as exc:  # pragma: no cover - broken/partial bundle
            self._set_info(
                f"Could not generate an API key: {exc}\n\nEnter one by hand instead — any long random string works."
            )
            return
        self.token_var.set(token)
        self._reveal_token(True)  # you cannot copy-check what you cannot see
        copied = self._copy_to_clipboard(token)
        head = "New API key generated" + (
            " and copied to the clipboard." if copied else " (clipboard unavailable — copy it above)."
        )
        paste = f"\n\nPaste it into {PASTE_LOCATION}. Clients still using the old key are refused."

        host, port = self.host_var.get(), self.port_var.get()
        saved, note = self._save_settings(host, port, token)
        if not saved:
            self._set_info(head + note)
            return
        self._refresh_service(port)
        if drives_service(self.service) and not self.ctl.running():
            self.on_service("restart", note=f"\n\n{head}{paste}{note}")
        elif self.ctl.running():
            self.on_restart()
            self._set_info(f"{head} Restarting the backend with it…{paste}{note}")
        else:
            self._set_info(f"{head}{paste}\n\nSaved; the backend uses it from its next Start.{note}")

    def on_copy_token(self) -> None:
        """Copy the current key to the clipboard."""
        token = self.token_var.get().strip()
        if not token:
            self._set_info("There is no API key to copy. Press Generate to make one.")
            return
        if self._copy_to_clipboard(token):
            self._set_info(f"API key copied. Paste it into {PASTE_LOCATION}.")
        else:
            self._set_info("Could not reach the clipboard. Press Show and copy the key by hand.")

    def toggle_token_visibility(self) -> None:
        self._reveal_token(self.token_entry.cget("show") != "")

    def _reveal_token(self, reveal: bool) -> None:
        self.token_entry.config(show="" if reveal else TOKEN_MASK_CHAR)
        self.reveal_btn.config(text="Hide" if reveal else "Show")

    def _copy_to_clipboard(self, text: str) -> bool:
        """Put `text` on the Windows clipboard. False if the clipboard refused.

        ``update()`` is required: Tk owns the clipboard only while it is
        processing events, and without it the value disappears the moment this
        window loses focus — which is exactly when the operator goes to paste.
        """
        try:
            self.root.clipboard_clear()
            self.root.clipboard_append(text)
            self.root.update()
            return True
        except Exception:  # pragma: no cover - clipboard owned by another app
            return False

    # ---- installed service ----
    def _refresh_service(self, port: str | None = None) -> bool:
        """Update the installed-service line; True when it serves `port`.

        Shells out to sc.exe and netstat, so it runs on demand (startup, Start,
        Refresh, after a service action) rather than on the liveness timer.
        """
        port = port or self._server_settings()[1]
        status = query_installed_service()
        owns = windows_admin.service_owns_port(status, port)
        self.service = status
        self.service_port = port if owns else None
        self.service_var.set(service_label(status, owns, port))
        return owns

    def on_service(self, action: str, note: str = "") -> None:
        """Start/stop/restart the installed service behind a UAC prompt.

        Runs off the Tk thread: the elevated command waits for the service to
        change state, and the window must stay responsive meanwhile.
        """
        generation = self._generation
        waiting = "waiting for administrator approval…" if sys.platform == "win32" else "working…"
        self._set_info(f"{action.capitalize()} service: {waiting}{note}")

        def work() -> None:
            error: Exception | None = None
            try:
                control_installed_service(action)
            except (windows_admin.ElevationDeclined, windows_admin.ElevatedActionFailed) as exc:
                error = exc
            self._post_info_for(generation, windows_admin.service_action_message(action, error) + note)

        threading.Thread(target=work, daemon=True).start()

    def on_stop(self) -> None:
        if drives_service(self.service) and not self.ctl.running():
            self.on_service("stop")
            return
        message = self.ctl.stop()
        # Invalidate any readiness poll still watching the process we just
        # killed; otherwise its "Start failed" lands on top of this message.
        self._generation += 1
        self.active = None
        self._set_info(f"Stop: {message}")
        self._refresh_status()

    def on_restart(self) -> None:
        if drives_service(self.service) and not self.ctl.running():
            # on_start saves the form, then restarts a running service.
            self.on_start()
            return
        self.ctl.stop()
        self.on_start()

    def _server_settings(self) -> tuple[str, str, str]:
        """host/port/token of the running child, else the installed service's
        saved settings, else the form.

        The fields stay editable while the server runs, so Refresh and the
        health link built from them would hit a port nothing is bound to.
        """
        if self.active:
            return self.active
        if drives_service(self.service):
            # The service runs on what was saved, not on edits not yet applied.
            saved = effective_config()
            return saved["host"], saved["port"], saved["token"]
        return (self.host_var.get(), self.port_var.get(), self.token_var.get())

    def on_refresh(self) -> None:
        self._refresh_service()
        if not (self.ctl.running() or self.service.state == "running"):
            self._set_info("Server is not running.")
            return
        health = fetch_health(*self._server_settings())
        if not health:
            self._set_info("Could not reach /health yet (still starting?). Try again.")
            return
        caps = health.get("capabilities", {})
        gpus = caps.get("gpus") or []
        gpu_txt = (
            "; ".join(
                f"{g.get('name', 'GPU')} ({g.get('free_vram_mb', '?')}MB free / {g.get('total_vram_mb', '?')}MB)"
                for g in gpus
            )
            or "none (CPU)"
        )
        lines = [
            f"version:      {caps.get('version', '?')}",
            f"authRequired: {caps.get('authRequired')}",
            f"ffmpeg:       {health.get('ffmpeg')}",
            f"RAM:          {health.get('availableRamMb', '?')} / {health.get('totalRamMb', '?')} MB",
            f"devices:      {', '.join(caps.get('devices', []))}",
            f"computeTypes: {', '.join(caps.get('computeTypes', []))}",
            f"transports:   {', '.join(caps.get('transportModes', []))}",
            f"GPUs:         {gpu_txt}",
            f"models:       {', '.join(caps.get('models', []))}",
        ]
        self._set_info("\n".join(lines))

    def _poll_status(self) -> None:
        """Re-check liveness on a timer so a crashed backend stops reading as up."""
        self._refresh_status()
        self.root.after(self.STATUS_POLL_MS, self._poll_status)

    def _refresh_status(self) -> None:
        running = self.ctl.running()
        if not running:
            self.active = None  # a dead process owns no settings
        if drives_service(self.service) and not running:
            # sc.exe only: the listener check (netstat) stays with _refresh_service.
            self.service = query_installed_service()
            running = self.service.state == "running"
            self.status_var.set(service_status_label(self.service, self.service_port))
        else:
            current = (self.host_var.get(), self.port_var.get(), self.token_var.get())
            self.status_var.set(status_label(running, self.active, current))
        if self._tray_icon is not None:
            try:
                self._tray_icon.icon = _icon_image(running)
            except Exception:
                pass

    def open_health(self) -> None:
        host, port, _token = self._server_settings()
        webbrowser.open(health_url(host, port))

    def open_logs(self) -> None:
        # The folder of this window's server log: the service's folder may be
        # administrators-only, and then this window's log lives elsewhere.
        folder = self._log_file().parent
        try:
            folder.mkdir(parents=True, exist_ok=True)
            self._open(folder)
        except Exception as exc:
            self._set_info(f"Could not open {folder}: {exc}")

    def _log_file(self) -> Path:
        """The log of the server the buttons control: the service's, or this window's own."""
        if drives_service(self.service) and not self.ctl.running():
            return resolve_log_file()
        return self.ctl.log_file or gui_log_file()

    def view_log(self) -> None:
        """Show the tail of this window's server log in a window.

        "Open logs" only ever opened Explorer at the folder, which is no help
        when the question is "what did the server just say". Reads the file
        directly rather than going through the server's /logs endpoint so it
        still works when the server is down — which is exactly when the log
        matters most.
        """
        log_file = self._log_file()
        win = tk.Toplevel(self.root)
        win.title(f"SubSmelt Whisper log — {log_file}")
        win.geometry("900x520")

        bar = ttk.Frame(win)
        bar.pack(fill="x", padx=8, pady=6)
        status = ttk.Label(bar, text="")
        status.pack(side="left")

        text = tk.Text(win, wrap="none", font=("Consolas", 9))
        yscroll = ttk.Scrollbar(win, orient="vertical", command=text.yview)
        xscroll = ttk.Scrollbar(win, orient="horizontal", command=text.xview)
        text.configure(yscrollcommand=yscroll.set, xscrollcommand=xscroll.set)
        yscroll.pack(side="right", fill="y")
        xscroll.pack(side="bottom", fill="x")
        text.pack(side="left", fill="both", expand=True, padx=(8, 0), pady=(0, 8))

        def reload_log() -> None:
            # Re-resolve each time: a Start since this window opened may have
            # given the child a different path.
            lines, note = read_log_tail(self._log_file(), LOG_TAIL_LINES)
            text.configure(state="normal")
            text.delete("1.0", "end")
            text.insert("1.0", "\n".join(lines) if lines else note)
            text.configure(state="disabled")
            text.see("end")  # tail view: newest at the bottom
            status.config(text=note if lines else "")

        ttk.Button(bar, text="Refresh", command=reload_log).pack(side="right", padx=4)
        ttk.Button(bar, text="Open folder", command=self.open_logs).pack(side="right", padx=4)
        reload_log()

    def open_config(self) -> None:
        """Open config.json; the installed one in an elevated Notepad."""
        error = windows_admin.open_config(self.config_file, self._open)
        if error:
            self._set_info(error)

    @staticmethod
    def _open(path: Path) -> None:
        """Open with the OS handler. Raises, so callers can report a failure."""
        if os.name == "nt":
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=True)
        else:
            subprocess.run(["xdg-open", str(path)], check=True)

    # ---- tray / lifecycle ----
    def hide_to_tray(self) -> None:
        """Window close → hide to tray; server keeps running."""
        if self._tray_icon is None:
            # No tray available: closing actually quits (after stopping server).
            self.quit_app()
            return
        self.root.withdraw()

    def show_window(self, *_args) -> None:
        self.root.after(0, self.root.deiconify)
        self.root.after(0, self.root.lift)

    def quit_app(self, *_args) -> None:
        self.ctl.stop()
        if self._tray_icon is not None:
            try:
                self._tray_icon.stop()
            except Exception:
                pass
        self.root.after(0, self.root.destroy)

    def _start_tray(self) -> None:
        if not _HAS_TRAY:
            return
        if sys.platform == "darwin":
            # NSStatusItem must be created on the main thread, which Tk's
            # mainloop owns here. The macOS menu-bar app is the tray instead;
            # a second icon would SIGTRAP the process at setMenu:.
            return
        menu = pystray.Menu(
            pystray.MenuItem("Show window", self.show_window, default=True),
            pystray.MenuItem("Quit (stops server)", self.quit_app),
        )
        self._tray_icon = pystray.Icon(
            "subsmelt_whisper_gui", _icon_image(False), f"SubSmelt Whisper Backend {APP_VERSION}", menu
        )
        threading.Thread(target=self._tray_icon.run, daemon=True).start()

    def run(self) -> None:
        self._start_tray()
        self.root.mainloop()


def main(argv: list[str] | None = None) -> int:
    if not _HAS_TK:
        print("[gui] tkinter is not available in this build.", file=sys.stderr)
        return 1
    WhisperGuiApp().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
