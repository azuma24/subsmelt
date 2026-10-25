#!/usr/bin/env python3
"""SubSmelt Whisper system-tray app (plan Phase 3 "System tray app").

Scaffold using `pystray` + `pillow`. Shows a status icon and a menu:
    Start service / Stop service / Open logs / Model manager /
    Open config / Run diagnostics (run_server --check) / Quit.

Failures are shown as a notification on the tray icon: the windowed exe has no
console, so anything only printed is lost.

DEPENDENCIES: pystray and pillow are EXTRA deps for the tray build ONLY — they are
NOT in the backend's requirements.txt and not needed to run the server. The
tray exe is built separately (see packaging/windows/README.md). The imports are
guarded so this file syntax-checks and `--help` works on any box without them.

WINDOWS-FIRST: service start/stop shells out to `sc.exe`/PowerShell, and
diagnostics calls the Phase 3a provision doctor. On non-Windows it still imports
and prints config (useful for local syntax/dry-run testing) but the service
actions are no-ops with a clear message.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import webbrowser
from pathlib import Path

# pystray/pillow are optional (tray-build-only). Import lazily so this module is
# importable and syntax-checkable without them.
try:
    import pystray  # type: ignore
    from PIL import Image, ImageDraw  # type: ignore

    _HAS_TRAY = True
except Exception:  # pragma: no cover - deps absent outside the tray build
    pystray = None  # type: ignore
    Image = ImageDraw = None  # type: ignore
    _HAS_TRAY = False

try:
    import windows_admin
    from gui_config import config_path, data_dir, dev_server_script, effective_config
    from server_launch import ServerExecutableNotFound, resolve_server_command
except ImportError:  # pragma: no cover - this file's dir isn't on sys.path yet
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    if sys.platform == "darwin":
        # service_control.py lives beside the macOS packaging, not here.
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "macos"))
    import windows_admin
    from gui_config import config_path, data_dir, dev_server_script, effective_config
    from server_launch import ServerExecutableNotFound, resolve_server_command

SERVICE_NAME = windows_admin.SERVICE_NAME
NOTIFY_TITLE = "SubSmelt Whisper"
# Windows balloon notifications truncate silently past about this length.
NOTIFY_MAX_CHARS = 200


# ---------------------------------------------------------------------------
# Actions (all guard against non-Windows so the file is runnable for testing)
# ---------------------------------------------------------------------------


def _is_windows() -> bool:
    return os.name == "nt"


def _is_macos() -> bool:
    return sys.platform == "darwin"


def _run(cmd: list[str]) -> tuple[int, str]:
    """Run a command, returning (returncode, combined output). Never raises."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:  # pragma: no cover - environment dependent
        return 1, str(exc)


def _report(icon, text: str) -> None:
    """Tell the operator something. The windowed exe has no console, so a
    print alone is silence; the tray icon's notification is what they see."""
    print(f"[tray] {text}")
    if icon is None or not hasattr(icon, "notify"):
        return
    try:
        icon.notify(text[:NOTIFY_MAX_CHARS], NOTIFY_TITLE)
    except Exception:  # pragma: no cover - backend without notification support
        pass


def _last_line(output: str) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def log_dir() -> Path:
    return data_dir() / "logs"


# ---------------------------------------------------------------------------
# Standalone mode: the tray OWNS a run_server.exe child process (no Windows
# Service). This is what you get when you run the built bundle directly instead
# of installing the service — the tray launches, controls, and closes the server.
# ---------------------------------------------------------------------------

_server_proc: subprocess.Popen | None = None


def _server_command() -> list[str]:
    """Resolve how to launch the server in standalone mode.

    Frozen (whisper-tray.exe): the run_server executable, searched across the
    layouts the build can produce. Dev: the repo's run_server.py with the current
    interpreter. Raises ServerExecutableNotFound when nothing resolves.
    """
    return resolve_server_command(dev_server_script())


def server_process_running() -> bool:
    return _server_proc is not None and _server_proc.poll() is None


def start_server_process(icon=None, _item=None) -> None:
    """Launch run_server.exe as a child process (standalone mode)."""
    global _server_proc
    if server_process_running():
        print("[tray] server already running.")
        return
    try:
        cmd = _server_command()
    except ServerExecutableNotFound as exc:
        _report(icon, f"failed to start server: {exc}")
        return
    try:
        # CREATE_NEW_PROCESS_GROUP lets us signal it independently on Windows.
        creationflags = 0x00000200 if _is_windows() else 0  # CREATE_NEW_PROCESS_GROUP
        _server_proc = subprocess.Popen(cmd, creationflags=creationflags)
        print(f"[tray] started server: {' '.join(cmd)} (pid {_server_proc.pid})")
    except Exception as exc:  # pragma: no cover - environment dependent
        _report(icon, f"failed to start server: {exc}")


def stop_server_process(icon=None, _item=None) -> None:
    """Terminate the server child process (standalone mode)."""
    global _server_proc
    if not server_process_running():
        print("[tray] server not running.")
        _server_proc = None
        return
    proc = _server_proc
    try:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        print("[tray] server stopped.")
    except Exception as exc:  # pragma: no cover
        _report(icon, f"failed to stop server: {exc}")
    finally:
        _server_proc = None


def restart_server_process(icon=None, _item=None) -> None:
    stop_server_process(icon)
    start_server_process(icon)


def _server_port() -> str:
    """The port the server binds, resolved as run_server does: env, then
    config.json, then the default. Read per click so a config edit counts."""
    return effective_config()["port"]


def open_health(_icon=None, _item=None) -> None:
    webbrowser.open(f"http://127.0.0.1:{_server_port()}/health")


def quit_standalone(icon=None, _item=None) -> None:
    """Quit the tray AND stop the owned server process."""
    stop_server_process(icon)
    if icon is not None and hasattr(icon, "stop"):
        icon.stop()


def _service_control(icon, verb: str) -> None:
    if _is_windows():
        # Service control is administrator-only; the tray stays unelevated and
        # asks for approval per action.
        error: Exception | None = None
        try:
            windows_admin.control_service(verb)
        except (windows_admin.ElevationDeclined, windows_admin.ElevatedActionFailed) as exc:
            error = exc
        _report(icon, windows_admin.service_action_message(verb, error))
        return
    if _is_macos():
        # The LaunchAgent belongs to the user; launchctl needs no elevation.
        from service_control import start_service, stop_service

        code, out = start_service() if verb == "start" else stop_service()
        if code != 0:
            _report(icon, f"{verb} service failed (rc={code}): {_last_line(out)}")
        else:
            print(f"[tray] {verb} service rc={code}: {out.strip()}")
        return
    print(f"[tray] {verb}_service is a no-op off Windows.")


def start_service(icon=None, _item=None) -> None:
    _service_control(icon, "start")


def stop_service(icon=None, _item=None) -> None:
    _service_control(icon, "stop")


def service_status() -> str:
    if _is_windows():
        return windows_admin.query_service().state
    if _is_macos():
        from service_control import service_status as launchd_status

        return launchd_status()
    return "unknown (non-Windows)"


def status_line() -> str:
    """The menu's status text: the state plus the port it answers on."""
    state = service_status()
    if state == "running":
        return f"Running, port {_server_port()}"
    return state


def open_control_window(_icon=None, _item=None) -> None:
    """Open the Tk control window in its own process.

    Tk wants the main thread, and pystray owns this process's main loop, so the
    window runs as a child: the same frozen binary re-executed with --window.
    """
    if getattr(sys, "frozen", False):
        subprocess.Popen([sys.executable, "--window"])
    else:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--window"])


def open_logs(icon=None, _item=None) -> None:
    try:
        log_dir().mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        _report(icon, f"could not create {log_dir()}: {exc}")
        return
    _open_path(log_dir(), icon)


def open_config(icon=None, _item=None) -> None:
    """Open the config file the server reads (gui_config.config_path, which
    honours SUBSMELT_WHISPER_CONFIG the way run_server does). The installed
    service's config is administrator-only, so that one opens elevated."""
    error = windows_admin.open_config(config_path(), _open_with_handler)
    if error:
        _report(icon, error)


def open_model_manager(_icon=None, _item=None) -> None:
    """Open the model manager.

    INTEGRATION POINT (plan Phase 3 "Model manager"): point this at the model
    manager UI. For now it opens the server's model page on the configured port
    (served by the backend) so the tray is wired even before the dedicated UI
    ships.
    """
    webbrowser.open(f"http://127.0.0.1:{_server_port()}/")


def _diagnostics_command() -> list[str]:
    """The doctor to run: a bundled provision.exe if one is next to us, else the
    server's own ``--check`` (config + CUDA/cuDNN probe).

    The server is resolved the same way Start is. When frozen, sys.executable
    is whisper-tray.exe itself, so the old ``sys.executable -m app.provision``
    fallback relaunched the tray instead of running any check.
    """
    provision_exe = Path(sys.executable).parent / "provision.exe"
    if provision_exe.exists():
        return [str(provision_exe), "--doctor"]
    return [*_server_command(), "--check"]


def run_diagnostics(icon=None, _item=None) -> None:
    """Re-runnable 'doctor' (plan Phase 3a)."""
    try:
        cmd = _diagnostics_command()
    except ServerExecutableNotFound as exc:
        _report(icon, f"diagnostics unavailable: {exc}")
        return
    code, out = _run(cmd)
    print(f"[tray] diagnostics rc={code}:\n{out.strip()}")
    # The CUDA verdict is the first thing --check prints; an error is the last.
    if code == 0:
        _report(icon, f"diagnostics passed: {out.strip()}")
    else:
        _report(icon, f"diagnostics failed (rc={code}): {_last_line(out)}")


def quit_app(icon=None, _item=None) -> None:
    if icon is not None and hasattr(icon, "stop"):
        icon.stop()


def _open_with_handler(path: Path) -> None:
    """Open a file/folder with the OS default handler. Raises on failure."""
    if _is_windows():
        os.startfile(str(path))  # type: ignore[attr-defined]
        return
    code, out = _run(["open" if sys.platform == "darwin" else "xdg-open", str(path)])
    if code != 0:
        raise OSError(_last_line(out) or f"exit code {code}")


def _open_path(path: Path, icon=None) -> None:
    """Open a file/folder with the OS default handler (cross-platform)."""
    try:
        _open_with_handler(path)
    except Exception as exc:
        _report(icon, f"could not open {path}: {exc}")


# ---------------------------------------------------------------------------
# Icon + menu
# ---------------------------------------------------------------------------


def _make_icon_image():
    """Build a simple status icon (green dot) with Pillow."""
    img = Image.new("RGB", (64, 64), color=(28, 28, 30))
    draw = ImageDraw.Draw(img)
    draw.ellipse((16, 16, 48, 48), fill=(46, 204, 113))
    return img


def build_tray():
    """Construct the pystray.Icon. Requires pystray + pillow."""
    if not _HAS_TRAY:
        raise RuntimeError("pystray and pillow are required for the tray app. Install with: pip install pystray pillow")
    menu_items = [
        pystray.MenuItem(lambda _: f"Status: {status_line()}", None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Start service", start_service),
        pystray.MenuItem("Stop service", stop_service),
    ]
    if _is_macos():
        menu_items.append(pystray.MenuItem("Open control window", open_control_window))
    menu_items += [
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Open logs", open_logs),
        pystray.MenuItem("Model manager", open_model_manager),
        pystray.MenuItem("Open config", open_config),
        pystray.MenuItem("Run diagnostics", run_diagnostics),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", quit_app),
    ]
    return pystray.Icon("subsmelt_whisper", _make_icon_image(), "SubSmelt Whisper Backend", pystray.Menu(*menu_items))


def build_standalone_tray():
    """Tray that owns a run_server.exe child process (no Windows Service)."""
    if not _HAS_TRAY:
        raise RuntimeError("pystray and pillow are required for the tray app. Install with: pip install pystray pillow")
    menu = pystray.Menu(
        pystray.MenuItem(
            lambda _: f"Server: {'running' if server_process_running() else 'stopped'}",
            None,
            enabled=False,
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Start server", start_server_process, enabled=lambda _: not server_process_running()),
        pystray.MenuItem("Stop server", stop_server_process, enabled=lambda _: server_process_running()),
        pystray.MenuItem("Restart server", restart_server_process),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Open health page", open_health),
        pystray.MenuItem("Open logs", open_logs),
        pystray.MenuItem("Open config", open_config),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit (stops server)", quit_standalone),
    )
    return pystray.Icon("subsmelt_whisper", _make_icon_image(), "SubSmelt Whisper Backend (standalone)", menu)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="whisper_tray",
        description="SubSmelt Whisper system-tray controller (Windows tray build).",
    )
    parser.add_argument(
        "--standalone",
        action="store_true",
        help="Own a run_server.exe child process instead of the "
        "Windows Service. Auto-starts the server, then the "
        "tray Start/Stop/Quit control it directly.",
    )
    parser.add_argument(
        "--no-autostart", action="store_true", help="In --standalone mode, do NOT start the server on launch."
    )
    parser.add_argument("--status", action="store_true", help="Print service status and exit (no tray).")
    parser.add_argument("--diagnostics", action="store_true", help="Run the provisioning doctor and exit (no tray).")
    parser.add_argument(
        "--window", action="store_true", help="Open the Tk control window and exit (how the menu-bar app opens it)."
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    if args.window:
        from whisper_gui import main as gui_main

        return gui_main()
    if args.status:
        print(f"service '{SERVICE_NAME}': {service_status()}")
        return 0
    if args.diagnostics:
        run_diagnostics()
        return 0

    if not _HAS_TRAY:
        print(
            "[tray] pystray/pillow not installed — cannot show the tray. "
            "Use --status or --diagnostics, or install with: pip install pystray pillow",
            file=sys.stderr,
        )
        return 1

    if args.standalone:
        # Make sure the owned server is stopped if the tray dies unexpectedly.
        import atexit

        atexit.register(stop_server_process)
        if not args.no_autostart:
            start_server_process()
        build_standalone_tray().run()
        return 0

    build_tray().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
