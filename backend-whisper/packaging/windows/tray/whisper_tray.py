#!/usr/bin/env python3
"""SubSmelt Whisper system-tray app (plan Phase 3 "System tray app").

Scaffold using `pystray` + `pillow`. Shows a status icon and a menu:
    Start service / Stop service / Open logs / Model manager /
    Open config / Run diagnostics (provision doctor) / Quit.

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

SERVICE_NAME = os.environ.get("SUBSMELT_WHISPER_SERVICE", "SubSmeltWhisper")
DATA_DIR = Path(os.environ.get("SUBSMELT_DATA_DIR", r"C:\ProgramData\SubSmelt"))
CONFIG_PATH = DATA_DIR / "config.json"
LOG_DIR = DATA_DIR / "logs"
DEFAULT_PORT = os.environ.get("SUBSMELT_WHISPER_PORT", "8001")


# ---------------------------------------------------------------------------
# Actions (all guard against non-Windows so the file is runnable for testing)
# ---------------------------------------------------------------------------

def _is_windows() -> bool:
    return os.name == "nt"


def _run(cmd: list[str]) -> tuple[int, str]:
    """Run a command, returning (returncode, combined output). Never raises."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=60, check=False
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:  # pragma: no cover - environment dependent
        return 1, str(exc)


# ---------------------------------------------------------------------------
# Standalone mode: the tray OWNS a run_server.exe child process (no Windows
# Service). This is what you get when you run the built bundle directly instead
# of installing the service — the tray launches, controls, and closes the server.
# ---------------------------------------------------------------------------

_server_proc: "subprocess.Popen | None" = None


def _server_command() -> list[str]:
    """Resolve how to launch the server in standalone mode.

    Frozen (whisper-tray.exe): run the sibling run_server.exe in the same dir.
    Dev: run the repo's run_server.py with the current interpreter.
    """
    if getattr(sys, "frozen", False):
        return [str(Path(sys.executable).parent / "run_server.exe")]
    return [sys.executable, str(Path(__file__).resolve().parents[3] / "run_server.py")]


def server_process_running() -> bool:
    return _server_proc is not None and _server_proc.poll() is None


def start_server_process(_icon=None, _item=None) -> None:
    """Launch run_server.exe as a child process (standalone mode)."""
    global _server_proc
    if server_process_running():
        print("[tray] server already running.")
        return
    cmd = _server_command()
    try:
        # CREATE_NEW_PROCESS_GROUP lets us signal it independently on Windows.
        creationflags = 0x00000200 if _is_windows() else 0  # CREATE_NEW_PROCESS_GROUP
        _server_proc = subprocess.Popen(cmd, creationflags=creationflags)
        print(f"[tray] started server: {' '.join(cmd)} (pid {_server_proc.pid})")
    except Exception as exc:  # pragma: no cover - environment dependent
        print(f"[tray] failed to start server: {exc}")


def stop_server_process(_icon=None, _item=None) -> None:
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
        print(f"[tray] failed to stop server: {exc}")
    finally:
        _server_proc = None


def restart_server_process(_icon=None, _item=None) -> None:
    stop_server_process()
    start_server_process()


def open_health(_icon=None, _item=None) -> None:
    webbrowser.open(f"http://127.0.0.1:{DEFAULT_PORT}/health")


def quit_standalone(icon=None, _item=None) -> None:
    """Quit the tray AND stop the owned server process."""
    stop_server_process()
    if icon is not None and hasattr(icon, "stop"):
        icon.stop()


def start_service(_icon=None, _item=None) -> None:
    if not _is_windows():
        print("[tray] start_service is a no-op off Windows.")
        return
    code, out = _run(["sc.exe", "start", SERVICE_NAME])
    print(f"[tray] start service rc={code}: {out.strip()}")


def stop_service(_icon=None, _item=None) -> None:
    if not _is_windows():
        print("[tray] stop_service is a no-op off Windows.")
        return
    code, out = _run(["sc.exe", "stop", SERVICE_NAME])
    print(f"[tray] stop service rc={code}: {out.strip()}")


def service_status() -> str:
    if not _is_windows():
        return "unknown (non-Windows)"
    code, out = _run(["sc.exe", "query", SERVICE_NAME])
    if code != 0:
        return "not installed"
    if "RUNNING" in out:
        return "running"
    if "STOPPED" in out:
        return "stopped"
    return "unknown"


def open_logs(_icon=None, _item=None) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    _open_path(LOG_DIR)


def open_config(_icon=None, _item=None) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text("{}\n", encoding="utf-8")
    _open_path(CONFIG_PATH)


def open_model_manager(_icon=None, _item=None) -> None:
    """Open the model manager.

    INTEGRATION POINT (plan Phase 3 "Model manager"): point this at the model
    manager UI. For now it opens the server's model page on the configured port
    (served by the backend) so the tray is wired even before the dedicated UI
    ships.
    """
    webbrowser.open(f"http://127.0.0.1:{DEFAULT_PORT}/")


def run_diagnostics(_icon=None, _item=None) -> None:
    """Re-runnable 'doctor' (plan Phase 3a).

    Calls the provisioning doctor — preferred bundled provision.exe, falling back
    to `python -m app.provision`. INTEGRATION POINT: wire to the real module once
    Phase 3a lands; for now it reports whichever is available.
    """
    provision_exe = Path(sys.executable).parent / "provision.exe"
    if provision_exe.exists():
        code, out = _run([str(provision_exe), "doctor"])
    else:
        code, out = _run([sys.executable, "-m", "app.provision", "doctor"])
    print(f"[tray] diagnostics rc={code}:\n{out.strip()}")


def quit_app(icon=None, _item=None) -> None:
    if icon is not None and hasattr(icon, "stop"):
        icon.stop()


def _open_path(path: Path) -> None:
    """Open a file/folder with the OS default handler (cross-platform)."""
    try:
        if _is_windows():
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            _run(["open", str(path)])
        else:
            _run(["xdg-open", str(path)])
    except Exception as exc:  # pragma: no cover
        print(f"[tray] could not open {path}: {exc}")


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
        raise RuntimeError(
            "pystray and pillow are required for the tray app. "
            "Install with: pip install pystray pillow"
        )
    menu = pystray.Menu(
        pystray.MenuItem(lambda _: f"Status: {service_status()}", None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Start service", start_service),
        pystray.MenuItem("Stop service", stop_service),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Open logs", open_logs),
        pystray.MenuItem("Model manager", open_model_manager),
        pystray.MenuItem("Open config", open_config),
        pystray.MenuItem("Run diagnostics", run_diagnostics),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", quit_app),
    )
    return pystray.Icon("subsmelt_whisper", _make_icon_image(),
                        "SubSmelt Whisper Backend", menu)


def build_standalone_tray():
    """Tray that owns a run_server.exe child process (no Windows Service)."""
    if not _HAS_TRAY:
        raise RuntimeError(
            "pystray and pillow are required for the tray app. "
            "Install with: pip install pystray pillow"
        )
    menu = pystray.Menu(
        pystray.MenuItem(
            lambda _: f"Server: {'running' if server_process_running() else 'stopped'}",
            None, enabled=False,
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Start server", start_server_process,
                         enabled=lambda _: not server_process_running()),
        pystray.MenuItem("Stop server", stop_server_process,
                         enabled=lambda _: server_process_running()),
        pystray.MenuItem("Restart server", restart_server_process),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Open health page", open_health),
        pystray.MenuItem("Open logs", open_logs),
        pystray.MenuItem("Open config", open_config),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit (stops server)", quit_standalone),
    )
    return pystray.Icon("subsmelt_whisper", _make_icon_image(),
                        "SubSmelt Whisper Backend (standalone)", menu)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="whisper_tray",
        description="SubSmelt Whisper system-tray controller (Windows tray build).",
    )
    parser.add_argument("--standalone", action="store_true",
                        help="Own a run_server.exe child process instead of the "
                             "Windows Service. Auto-starts the server, then the "
                             "tray Start/Stop/Quit control it directly.")
    parser.add_argument("--no-autostart", action="store_true",
                        help="In --standalone mode, do NOT start the server on launch.")
    parser.add_argument("--status", action="store_true",
                        help="Print service status and exit (no tray).")
    parser.add_argument("--diagnostics", action="store_true",
                        help="Run the provisioning doctor and exit (no tray).")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    if args.status:
        print(f"service '{SERVICE_NAME}': {service_status()}")
        return 0
    if args.diagnostics:
        run_diagnostics()
        return 0

    if not _HAS_TRAY:
        print("[tray] pystray/pillow not installed — cannot show the tray. "
              "Use --status or --diagnostics, or install with: pip install pystray pillow",
              file=sys.stderr)
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
