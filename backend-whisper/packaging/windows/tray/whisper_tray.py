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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="whisper_tray",
        description="SubSmelt Whisper system-tray controller (Windows tray build).",
    )
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

    build_tray().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
