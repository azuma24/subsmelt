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
(CREATE_NO_WINDOW); point SUBSMELT_WHISPER_LOG_FILE at a file to keep its logs.

Deps: pystray + pillow (tray) are tray-build-only; tkinter is stdlib. All three
imports are guarded so this file syntax-checks anywhere.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
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

DATA_DIR = Path(os.environ.get("SUBSMELT_DATA_DIR", r"C:\ProgramData\SubSmelt"))
LOG_DIR = DATA_DIR / "logs"
CONFIG_PATH = DATA_DIR / "config.json"
CREATE_NO_WINDOW = 0x08000000  # Windows: don't open a console for the child


# ---------------------------------------------------------------------------
# Server child-process control
# ---------------------------------------------------------------------------

class ServerController:
    """Owns the run_server.exe child process with the chosen host/port/token."""

    def __init__(self) -> None:
        self._proc: "subprocess.Popen | None" = None

    @staticmethod
    def _command() -> list[str]:
        if getattr(sys, "frozen", False):
            return [str(Path(sys.executable).parent / "run_server.exe")]
        return [sys.executable, str(Path(__file__).resolve().parents[3] / "run_server.py")]

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
        flags = CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            self._proc = subprocess.Popen(self._command(), env=env, creationflags=flags)
            return f"started on http://{host}:{port}"
        except Exception as exc:  # pragma: no cover - environment dependent
            return f"failed to start: {exc}"

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


def fetch_health(host: str, port: str, token: str) -> dict | None:
    """GET /health (open route). Returns parsed JSON or None on failure."""
    import json
    url_host = "127.0.0.1" if host == "0.0.0.0" else host
    req = urllib.request.Request(f"http://{url_host}:{port}/health")
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
    def __init__(self) -> None:
        self.ctl = ServerController()
        self.root = tk.Tk()
        self.root.title("SubSmelt Whisper Backend")
        self.root.geometry("520x460")
        self._tray_icon = None
        self._build_ui()
        # Close button hides to tray instead of quitting.
        self.root.protocol("WM_DELETE_WINDOW", self.hide_to_tray)
        self._refresh_status()

    # ---- UI ----
    def _build_ui(self) -> None:
        pad = {"padx": 10, "pady": 4}
        frm = ttk.Frame(self.root)
        frm.pack(fill="both", expand=True, padx=12, pady=12)

        self.status_var = tk.StringVar(value="○ Stopped")
        ttk.Label(frm, textvariable=self.status_var, font=("Segoe UI", 12, "bold")).grid(
            row=0, column=0, columnspan=3, sticky="w", **pad)

        # Host
        ttk.Label(frm, text="Bind address:").grid(row=1, column=0, sticky="w", **pad)
        self.host_var = tk.StringVar(value="127.0.0.1")
        ttk.Radiobutton(frm, text="127.0.0.1 (local only)", variable=self.host_var,
                        value="127.0.0.1").grid(row=1, column=1, sticky="w")
        ttk.Radiobutton(frm, text="0.0.0.0 (LAN/remote)", variable=self.host_var,
                        value="0.0.0.0").grid(row=2, column=1, sticky="w")

        # Port
        ttk.Label(frm, text="Port:").grid(row=3, column=0, sticky="w", **pad)
        self.port_var = tk.StringVar(value="8001")
        ttk.Entry(frm, textvariable=self.port_var, width=10).grid(row=3, column=1, sticky="w")

        # Token
        ttk.Label(frm, text="Token (optional):").grid(row=4, column=0, sticky="w", **pad)
        self.token_var = tk.StringVar(value=os.environ.get("SUBSMELT_WHISPER_TOKEN", ""))
        ttk.Entry(frm, textvariable=self.token_var, width=28, show="•").grid(
            row=4, column=1, sticky="w")

        # Buttons
        btns = ttk.Frame(frm)
        btns.grid(row=5, column=0, columnspan=3, sticky="w", **pad)
        self.start_btn = ttk.Button(btns, text="Start", command=self.on_start)
        self.start_btn.pack(side="left", padx=4)
        self.stop_btn = ttk.Button(btns, text="Stop", command=self.on_stop)
        self.stop_btn.pack(side="left", padx=4)
        ttk.Button(btns, text="Restart", command=self.on_restart).pack(side="left", padx=4)
        ttk.Button(btns, text="Refresh", command=self.on_refresh).pack(side="left", padx=4)

        links = ttk.Frame(frm)
        links.grid(row=6, column=0, columnspan=3, sticky="w", **pad)
        ttk.Button(links, text="Open health page", command=self.open_health).pack(side="left", padx=4)
        ttk.Button(links, text="Open logs", command=self.open_logs).pack(side="left", padx=4)
        ttk.Button(links, text="Open config", command=self.open_config).pack(side="left", padx=4)

        # Info box (health output)
        ttk.Label(frm, text="Server info:").grid(row=7, column=0, sticky="nw", **pad)
        self.info = tk.Text(frm, height=10, width=58, wrap="word", state="disabled",
                            font=("Consolas", 9))
        self.info.grid(row=8, column=0, columnspan=3, sticky="nsew", padx=10, pady=6)
        frm.rowconfigure(8, weight=1)
        frm.columnconfigure(2, weight=1)

    def _set_info(self, text: str) -> None:
        self.info.config(state="normal")
        self.info.delete("1.0", "end")
        self.info.insert("1.0", text)
        self.info.config(state="disabled")

    # ---- actions ----
    def on_start(self) -> None:
        msg = self.ctl.start(self.host_var.get(), self.port_var.get(), self.token_var.get())
        self._set_info(f"Start: {msg}\n\nClick Refresh in a moment to read /health.")
        self._refresh_status()

    def on_stop(self) -> None:
        self._set_info(f"Stop: {self.ctl.stop()}")
        self._refresh_status()

    def on_restart(self) -> None:
        self.ctl.stop()
        self.on_start()

    def on_refresh(self) -> None:
        if not self.ctl.running():
            self._set_info("Server is not running.")
            return
        health = fetch_health(self.host_var.get(), self.port_var.get(), self.token_var.get())
        if not health:
            self._set_info("Could not reach /health yet (still starting?). Try again.")
            return
        caps = health.get("capabilities", {})
        gpus = caps.get("gpus") or []
        gpu_txt = "; ".join(
            f"{g.get('name','GPU')} ({g.get('free_vram_mb','?')}MB free / {g.get('total_vram_mb','?')}MB)"
            for g in gpus
        ) or "none (CPU)"
        lines = [
            f"version:      {caps.get('version','?')}",
            f"authRequired: {caps.get('authRequired')}",
            f"ffmpeg:       {health.get('ffmpeg')}",
            f"RAM:          {health.get('availableRamMb','?')} / {health.get('totalRamMb','?')} MB",
            f"devices:      {', '.join(caps.get('devices', []))}",
            f"computeTypes: {', '.join(caps.get('computeTypes', []))}",
            f"transports:   {', '.join(caps.get('transportModes', []))}",
            f"GPUs:         {gpu_txt}",
            f"models:       {', '.join(caps.get('models', []))}",
        ]
        self._set_info("\n".join(lines))

    def _refresh_status(self) -> None:
        running = self.ctl.running()
        host, port = self.host_var.get(), self.port_var.get()
        self.status_var.set(f"● Running on {host}:{port}" if running else "○ Stopped")
        if self._tray_icon is not None:
            try:
                self._tray_icon.icon = _icon_image(running)
            except Exception:
                pass

    def open_health(self) -> None:
        host = "127.0.0.1" if self.host_var.get() == "0.0.0.0" else self.host_var.get()
        webbrowser.open(f"http://{host}:{self.port_var.get()}/health")

    def open_logs(self) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self._open(LOG_DIR)

    def open_config(self) -> None:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        if not CONFIG_PATH.exists():
            CONFIG_PATH.write_text("{}\n", encoding="utf-8")
        self._open(CONFIG_PATH)

    @staticmethod
    def _open(path: Path) -> None:
        try:
            if os.name == "nt":
                os.startfile(str(path))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.run(["open", str(path)], check=False)
            else:
                subprocess.run(["xdg-open", str(path)], check=False)
        except Exception:
            pass

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
        menu = pystray.Menu(
            pystray.MenuItem("Show window", self.show_window, default=True),
            pystray.MenuItem("Quit (stops server)", self.quit_app),
        )
        self._tray_icon = pystray.Icon(
            "subsmelt_whisper_gui", _icon_image(False),
            "SubSmelt Whisper Backend", menu)
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
