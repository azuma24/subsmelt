#!/usr/bin/env python3
"""SubSmelt Whisper backend launcher (Phase 3 Windows packaging entrypoint).

This is a *thin* programmatic launcher for the existing FastAPI app
(``app.main:app``). It exists so the service can be frozen by PyInstaller
(``whisper-server.spec``) into ``run_server.exe`` and run as a Windows Service,
while remaining fully runnable on macOS/Linux for local testing.

It does three jobs and then hands off to uvicorn:

  1. Read configuration from environment variables (and an optional config file).
  2. Wire the runtime environment for the packaged case — point ``HF_HOME`` at the
     user-chosen model dir so models live where the model manager downloaded them,
     and (on Windows) put the bundled cuDNN/cuBLAS DLLs on the DLL search path.
  3. Verify the cuDNN/cuBLAS runtime can load *early*, emitting a clear, actionable
     message instead of letting the first transcription die with a raw
     ``cudnn_ops64_9.dll not found`` — the #1 packaging footgun (plan §4).

Config (all optional; sensible localhost defaults):
    SUBSMELT_WHISPER_HOST    bind host   (default 127.0.0.1; see note below)
    SUBSMELT_WHISPER_PORT    bind port   (default 8001)
    SUBSMELT_WHISPER_MODEL_DIR   model cache dir -> exported as HF_HOME/XDG_CACHE_HOME
    SUBSMELT_WHISPER_TOKEN   shared-secret bearer token (Phase 1 auth)
    SUBSMELT_WHISPER_MEDIA_ROOT  allowed media root -> exported as MEDIA_ROOT
    SUBSMELT_FFMPEG          path to bundled ffmpeg.exe (consumed by app/audio.py)
    SUBSMELT_WHISPER_CONFIG  path to a JSON config file (env vars win over it)
    SUBSMELT_WHISPER_LOG_LEVEL   uvicorn log level (default "info")
    SUBSMELT_WHISPER_LOG_FILE    path to a rotating log file (5MB×5; default: console only)

Binding note (mirrors plan §1/Phase 1): we only auto-widen the default bind to
0.0.0.0 when a token is configured. Without a token we stay on 127.0.0.1 so a
fresh install is never exposed to the network unauthenticated. An explicit
SUBSMELT_WHISPER_HOST always wins.

Usage:
    python run_server.py            # start the server
    python run_server.py --help     # show resolved config and exit (no import of heavy deps)
    python run_server.py --check    # run startup checks (cuDNN probe) and exit
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8001
DEFAULT_LOG_LEVEL = "info"


@dataclass(frozen=True)
class ServerConfig:
    host: str
    port: int
    model_dir: str | None
    token: str | None
    media_root: str | None
    ffmpeg: str | None
    log_level: str
    log_file: str | None

    def redacted(self) -> dict:
        """Config safe to print/log — never leak the token."""
        return {
            "host": self.host,
            "port": self.port,
            "model_dir": self.model_dir,
            "media_root": self.media_root,
            "ffmpeg": self.ffmpeg,
            "log_level": self.log_level,
            "log_file": self.log_file,
            "token": "<set>" if self.token else None,
        }


def _load_config_file(path: str | None) -> dict:
    """Load a JSON config file if one is configured and present.

    Returns an empty dict when no file is configured or it is missing/invalid —
    env vars are authoritative, the file is only a convenience for the installer.
    """
    if not path:
        return {}
    file_path = Path(path)
    if not file_path.is_file():
        return {}
    try:
        with file_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError) as exc:
        # Fail loud-but-soft: warn and fall back to env/defaults rather than
        # refusing to start because of a malformed optional file.
        print(f"[run_server] WARNING: could not read config file {path}: {exc}",
              file=sys.stderr)
        return {}


def load_config() -> ServerConfig:
    """Resolve configuration from env vars, falling back to an optional JSON file."""
    file_cfg = _load_config_file(os.environ.get("SUBSMELT_WHISPER_CONFIG"))

    def pick(env_key: str, file_key: str, default: str | None = None) -> str | None:
        value = os.environ.get(env_key)
        if value is not None and value != "":
            return value
        file_value = file_cfg.get(file_key)
        if file_value is not None:
            return str(file_value)
        return default

    token = pick("SUBSMELT_WHISPER_TOKEN", "token", None)

    # Default bind: localhost unless a token is set (Phase 1 rule).
    default_host = "0.0.0.0" if token else DEFAULT_HOST
    host = pick("SUBSMELT_WHISPER_HOST", "host", default_host) or DEFAULT_HOST

    port_raw = pick("SUBSMELT_WHISPER_PORT", "port", str(DEFAULT_PORT))
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        print(f"[run_server] WARNING: invalid port {port_raw!r}, using {DEFAULT_PORT}",
              file=sys.stderr)
        port = DEFAULT_PORT

    return ServerConfig(
        host=host,
        port=port,
        model_dir=pick("SUBSMELT_WHISPER_MODEL_DIR", "model_dir", None),
        token=token,
        media_root=pick("SUBSMELT_WHISPER_MEDIA_ROOT", "media_root", None),
        ffmpeg=pick("SUBSMELT_FFMPEG", "ffmpeg", None),
        log_level=pick("SUBSMELT_WHISPER_LOG_LEVEL", "log_level", DEFAULT_LOG_LEVEL)
        or DEFAULT_LOG_LEVEL,
        log_file=pick("SUBSMELT_WHISPER_LOG_FILE", "log_file", None),
    )


# ---------------------------------------------------------------------------
# Environment wiring (applied before importing the heavy app/transcribe stack)
# ---------------------------------------------------------------------------

def apply_environment(config: ServerConfig) -> None:
    """Export resolved config into the process environment.

    The app reads MEDIA_ROOT / HF_HOME / SUBSMELT_FFMPEG / SUBSMELT_WHISPER_TOKEN
    directly from ``os.environ`` (see app/main.py, app/audio.py). We set them here
    so a single launcher config drives the whole server — important for the frozen
    Windows service where there is no shell to ``export`` them.
    """
    if config.model_dir:
        # faster-whisper resolves model weights via the Hugging Face cache; point it
        # at the user-chosen model dir so the model manager and the server agree.
        os.environ.setdefault("HF_HOME", config.model_dir)
        os.environ.setdefault("XDG_CACHE_HOME", config.model_dir)
        os.environ["SUBSMELT_WHISPER_MODEL_DIR"] = config.model_dir
    if config.media_root:
        os.environ["MEDIA_ROOT"] = config.media_root
    if config.token:
        os.environ["SUBSMELT_WHISPER_TOKEN"] = config.token
    if config.ffmpeg:
        os.environ["SUBSMELT_FFMPEG"] = config.ffmpeg


def add_bundled_dll_dir() -> None:
    """On Windows, add the bundled CUDA DLL dirs to the DLL search path.

    PyInstaller's spec collects the cuDNN/cuBLAS DLLs from the
    ``nvidia-cudnn-cu12`` / ``nvidia-cublas-cu12`` wheels next to the frozen exe.
    CTranslate2 loads them by name at first GPU use, so the directory containing
    them must be on the DLL search path. ``os.add_dll_directory`` is the modern,
    safe way to do this on Windows (Python 3.8+); it is a no-op concept elsewhere.
    """
    if os.name != "nt":
        return
    # When frozen, sys.frozen is set and sys._MEIPASS / the exe dir holds the bundle.
    base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    candidates = [base, base / "nvidia" / "cudnn" / "bin",
                  base / "nvidia" / "cublas" / "bin"]
    for candidate in candidates:
        if candidate.is_dir():
            try:
                os.add_dll_directory(str(candidate))  # type: ignore[attr-defined]
            except (OSError, AttributeError):
                # Non-fatal: the cuDNN probe below will surface a clear message
                # if the runtime genuinely cannot be loaded.
                pass


def verify_cuda_runtime() -> tuple[bool, str]:
    """Probe the CUDA runtime early via CTranslate2.

    Returns (gpu_available, human_message). This NEVER raises — a missing GPU or
    a failed cuDNN load must not stop the server from starting in CPU mode. It
    only produces the clear diagnostic the plan calls for (§Phase 3 risk #1).
    """
    try:
        import ctranslate2  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on packaged env
        return False, (
            "CTranslate2 is not importable — the server will run, but GPU "
            f"transcription is unavailable. Underlying error: {exc}"
        )
    try:
        count = ctranslate2.get_cuda_device_count()
    except Exception as exc:  # pragma: no cover - GPU/driver dependent
        return False, (
            "Could not query CUDA devices. If you expected GPU acceleration, the "
            "NVIDIA driver may be missing/too old, or the bundled cuDNN/cuBLAS "
            "DLLs (cudnn_ops64_9.dll, cublas64_12.dll) failed to load. "
            "Run diagnostics from the tray app or reinstall the CUDA runtime. "
            f"Underlying error: {exc}"
        )
    if count <= 0:
        return False, (
            "No CUDA device detected — running in CPU mode. Install/update the "
            "NVIDIA display driver for GPU acceleration (full CUDA Toolkit not "
            "required; the bundled cuDNN/cuBLAS wheels provide the runtime)."
        )
    return True, f"CUDA runtime OK — {count} device(s) available."


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="run_server",
        description="Launch the SubSmelt Whisper FastAPI backend via uvicorn.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Run startup checks (config + cuDNN/CUDA probe) and exit.",
    )
    parser.add_argument(
        "--print-config",
        action="store_true",
        help="Print the resolved (token-redacted) configuration and exit.",
    )
    return parser.parse_args(argv)


def configure_file_logging(config: "ServerConfig") -> bool:
    """Attach a rotating file handler when SUBSMELT_WHISPER_LOG_FILE is set.

    Windows services have no console, so log to a file (plan Phase 5). The handler
    is attached to the root logger plus uvicorn's loggers, and uvicorn is later
    told NOT to reset logging (``log_config=None``) so these handlers survive.
    Rotation: 5 MB × 5 backups. Returns True when file logging was enabled.
    """
    if not config.log_file:
        return False
    import logging
    from logging.handlers import RotatingFileHandler

    try:
        log_path = Path(config.log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            log_path, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s: %(message)s"
        ))
        level = getattr(logging, config.log_level.upper(), logging.INFO)
        root = logging.getLogger()
        root.setLevel(level)
        root.addHandler(handler)
        for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
            lg = logging.getLogger(name)
            lg.setLevel(level)
            lg.addHandler(handler)
        print(f"[run_server] file logging → {log_path} (level={config.log_level})")
        return True
    except OSError as exc:
        # Never refuse to start over a logging-path problem; warn and use console.
        print(f"[run_server] WARNING: could not open log file {config.log_file}: {exc}",
              file=sys.stderr)
        return False


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    config = load_config()

    if args.print_config:
        print(json.dumps(config.redacted(), indent=2))
        return 0

    apply_environment(config)
    add_bundled_dll_dir()
    file_logging = configure_file_logging(config)

    gpu_ok, message = verify_cuda_runtime()
    print(f"[run_server] {message}")

    if args.check:
        print("[run_server] config:", json.dumps(config.redacted()))
        return 0

    # Import uvicorn lazily so --help / --print-config / --check work in minimal
    # environments (and so syntax-checking this file never requires uvicorn).
    try:
        import uvicorn  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on installed env
        print(f"[run_server] FATAL: uvicorn is not installed: {exc}", file=sys.stderr)
        return 1

    print(
        f"[run_server] starting uvicorn on {config.host}:{config.port} "
        f"(gpu={'yes' if gpu_ok else 'no'})"
    )
    # Pass the import string (not the app object) so uvicorn owns the lifecycle;
    # reload is intentionally off for a service.
    run_kwargs = {
        "host": config.host,
        "port": config.port,
        "log_level": config.log_level,
        "reload": False,
    }
    # When we installed a file handler, tell uvicorn NOT to reset logging
    # (log_config=None) so our rotating handler stays attached. Otherwise let
    # uvicorn apply its default console logging (omit the kwarg) (plan Phase 5).
    if file_logging:
        run_kwargs["log_config"] = None
    uvicorn.run("app.main:app", **run_kwargs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
