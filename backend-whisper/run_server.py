#!/usr/bin/env python3
r"""SubSmelt Whisper backend launcher (the packaged apps' entrypoint).

This is a *thin* programmatic launcher for the existing FastAPI app
(``app.main:app``). It exists so the service can be frozen by PyInstaller
into ``run_server.exe`` run as a Windows Service
(``packaging/windows/whisper-server.spec``) and into ``whisper-server`` run as
a launchd agent on macOS (``packaging/macos/whisper-server.spec``), while
remaining runnable from source anywhere.

It does three jobs and then hands off to uvicorn:

  1. Read configuration from environment variables (and an optional config file).
  2. Wire the runtime environment for the packaged case — point ``HF_HOME`` at the
     user-chosen model dir so models live where the model manager downloaded them,
     and (on Windows) put the bundled cuDNN/cuBLAS DLLs on the DLL search path.
  3. Verify the cuDNN/cuBLAS runtime can load *early*, emitting a clear, actionable
     message instead of letting the first transcription die with a raw
     ``cudnn_ops64_9.dll not found`` — the #1 packaging footgun (plan §4).
     On macOS the probe reports the bundled nemo-speech (Metal) instead.

Config (all optional; sensible localhost defaults):
    SUBSMELT_WHISPER_HOST    bind host   (default 0.0.0.0; see note below)
    SUBSMELT_WHISPER_PORT    bind port   (default 8001)
    SUBSMELT_WHISPER_MODEL_DIR   model cache dir -> exported as HF_HOME/XDG_CACHE_HOME
    SUBSMELT_WHISPER_TOKEN   shared-secret bearer token (Phase 1 auth)
    SUBSMELT_WHISPER_MEDIA_ROOT  allowed media root -> exported as MEDIA_ROOT
    SUBSMELT_FFMPEG          path to the bundled ffmpeg (consumed by app/audio.py).
                             A frozen macOS app defaults to <exe dir>/ffmpeg/ffmpeg
    SUBSMELT_NEMO_SPEECH     path to the bundled nemo-speech binary that runs the
                             Nemotron ASR engine (config key "nemo_speech")
    SUBSMELT_WHISPER_CONFIG  path to a JSON config file (env vars win over it)
                             default: <data dir>/config.json
    SUBSMELT_WHISPER_LOG_LEVEL   uvicorn log level (default "info")
    SUBSMELT_WHISPER_LOG_FILE    path to a rotating log file (5MB×5)
                             Windows default: <data dir>\logs\whisper-server.log;
                             macOS: ~/Library/Logs/SubSmelt Whisper/whisper-server.log;
                             Linux: console only
    SUBSMELT_DATA_DIR        data dir holding config.json + logs\. Defaults:
                             Windows C:\ProgramData\SubSmelt,
                             macOS ~/Library/Application Support/SubSmelt,
                             Linux ${XDG_DATA_HOME:-~/.local/share}/subsmelt

Binding note: the default bind is 0.0.0.0, because SubSmelt normally runs in a
container or on another machine and a loopback-only backend is unreachable from
there. A wide bind with no SUBSMELT_WHISPER_TOKEN is warned about loudly at
startup; set the token, or SUBSMELT_WHISPER_HOST=127.0.0.1 for a local-only
backend. An explicit SUBSMELT_WHISPER_HOST always wins.

Usage:
    python run_server.py            # start the server
    python run_server.py --help     # show resolved config and exit (no import of heavy deps)
    python run_server.py --check    # run startup checks (cuDNN probe) and exit
    python run_server.py --generate-token           # print a new API key
    python run_server.py --generate-token --save    # ...and store it in config.json
                                                    # (add --force to rotate an existing key)
    run_server.exe --service        # Windows only: run under the Service Control
                                    # Manager (the installed service's binPath)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from app.token_gen import generate_token

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_HOST = "0.0.0.0"
LOOPBACK_HOST = "127.0.0.1"
DEFAULT_PORT = 8001
DEFAULT_LOG_LEVEL = "info"

# Packaging defaults. The installer, the tray app and the GUI all treat the data
# dir as the home of config.json — without these defaults the server read no
# config.json unless SUBSMELT_WHISPER_CONFIG was set by hand, so "Open config"
# edited a file nothing read and `--generate-token --save` had nowhere to save.
DEFAULT_WINDOWS_DATA_DIR = r"C:\ProgramData\SubSmelt"
DEFAULT_CONFIG_FILE_NAME = "config.json"
DEFAULT_LOG_FILE_NAME = "whisper-server.log"
MACOS_LOG_DIR_NAME = "SubSmelt Whisper"


def default_data_dir(env: dict[str, str] | None = None, platform: str | None = None) -> Path:
    """SUBSMELT_DATA_DIR, else the platform's application-data directory.

    Mirrors gui_config.data_dir in the control apps, which are frozen into
    separate exes and cannot import this; test_gui_config pins the two together.
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


def default_config_path(env: dict[str, str] | None = None, platform: str | None = None) -> str:
    return str(default_data_dir(env, platform) / DEFAULT_CONFIG_FILE_NAME)


def default_log_dir(env: dict[str, str] | None = None, platform: str | None = None) -> Path:
    """Where the backend's log files belong: ``~/Library/Logs/SubSmelt Whisper``
    on macOS, where Console.app looks, and ``<data dir>/logs`` elsewhere or when
    SUBSMELT_DATA_DIR moves the data dir."""
    environ = os.environ if env is None else env
    if platform is None:
        platform = sys.platform
    if platform == "darwin" and not (environ.get("SUBSMELT_DATA_DIR") or "").strip():
        return Path.home() / "Library" / "Logs" / MACOS_LOG_DIR_NAME
    return default_data_dir(env, platform) / "logs"


def default_log_file(env: dict[str, str] | None = None, platform: str | None = None) -> str | None:
    """The installed app's log file on Windows and macOS; None on Linux.

    Linux is left out on purpose: a file handler also turns uvicorn's console
    logging off (``log_config=None``), and the console is how a Docker container
    is watched. The GUI gives its own child an explicit SUBSMELT_WHISPER_LOG_FILE.
    """
    if platform is None:
        platform = sys.platform
    if platform not in ("win32", "darwin"):
        return None
    return str(default_log_dir(env, platform) / DEFAULT_LOG_FILE_NAME)


def bundled_ffmpeg() -> str | None:
    """``<exe dir>/ffmpeg/ffmpeg`` in the frozen macOS app, else None.

    launchd starts the app with a bare PATH, so a Homebrew ffmpeg is never
    found there; the app ships its own beside the executable.
    """
    if sys.platform != "darwin" or not getattr(sys, "frozen", False):
        return None
    return str(Path(sys.executable).resolve().parent / "ffmpeg" / "ffmpeg")


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
    nemo_speech: str | None = None
    version: str | None = None

    def redacted(self) -> dict:
        """Config safe to print/log — never leak the token."""
        return {
            "host": self.host,
            "port": self.port,
            "model_dir": self.model_dir,
            "media_root": self.media_root,
            "ffmpeg": self.ffmpeg,
            "nemo_speech": self.nemo_speech,
            "log_level": self.log_level,
            "log_file": self.log_file,
            "version": self.version,
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
        print(f"[run_server] WARNING: could not read config file {path}: {exc}", file=sys.stderr)
        return {}


def resolve_config_path() -> str:
    """The config file this launcher reads.

    An explicit ``SUBSMELT_WHISPER_CONFIG`` always wins; otherwise the platform
    data dir's config.json. ``--generate-token --save`` needs exactly this path,
    and resolving it twice by hand is how the two drift apart.
    """
    return os.environ.get("SUBSMELT_WHISPER_CONFIG") or default_config_path()


def write_config_token(path: str, token: str) -> None:
    """Merge ``token`` into the JSON config, preserving every other key.

    config.json is shared with the installed service and is hand-editable, so a
    token write must never become a config rewrite. Written via a temp file and
    an atomic replace: a half-written config would take the backend down on its
    next start, and this runs while the service may be live.
    """
    target = Path(path)
    existing: dict = {}
    try:
        loaded = json.loads(target.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            existing = loaded
    except (OSError, json.JSONDecodeError):
        existing = {}

    merged = {**existing, "token": token}
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".json.tmp")
    # Owner-only from the first byte: the file holds the token, and the replace
    # below would otherwise swap a locked-down config for a world-readable one.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(merged, indent=2) + "\n")
    tmp.replace(target)


def load_config() -> ServerConfig:
    """Resolve configuration from env vars, falling back to an optional JSON file."""
    config_path = resolve_config_path()
    file_cfg = _load_config_file(config_path)

    def pick(env_key: str, file_key: str, default: str | None = None) -> str | None:
        value = os.environ.get(env_key)
        if value is not None and value != "":
            return value
        file_value = file_cfg.get(file_key)
        if file_value is not None:
            return str(file_value)
        return default

    token = pick("SUBSMELT_WHISPER_TOKEN", "token", None)

    # Default bind: all interfaces. SubSmelt normally runs in Docker or on another
    # box, so a loopback-only backend is unreachable in the common deployment.
    # Binding wide without a token is warned about loudly at startup instead.
    host = pick("SUBSMELT_WHISPER_HOST", "host", DEFAULT_HOST) or DEFAULT_HOST

    port_raw = pick("SUBSMELT_WHISPER_PORT", "port", str(DEFAULT_PORT))
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        print(f"[run_server] WARNING: invalid port {port_raw!r}, using {DEFAULT_PORT}", file=sys.stderr)
        port = DEFAULT_PORT

    return ServerConfig(
        host=host,
        port=port,
        model_dir=pick("SUBSMELT_WHISPER_MODEL_DIR", "model_dir", None),
        token=token,
        media_root=pick("SUBSMELT_WHISPER_MEDIA_ROOT", "media_root", None),
        ffmpeg=pick("SUBSMELT_FFMPEG", "ffmpeg", bundled_ffmpeg()),
        log_level=pick("SUBSMELT_WHISPER_LOG_LEVEL", "log_level", DEFAULT_LOG_LEVEL) or DEFAULT_LOG_LEVEL,
        log_file=os.environ.get("SUBSMELT_WHISPER_LOG_FILE") or _guarded_log_file(file_cfg.get("log_file")),
        nemo_speech=pick("SUBSMELT_NEMO_SPEECH", "nemo_speech", None),
        version=pick("SUBSMELT_WHISPER_VERSION", "version", None),
    )


def _guarded_log_file(candidate: object) -> str | None:
    """A config.json ``log_file`` is honoured only inside the logs folder.

    The installed service runs as SYSTEM and config.json is hand-editable, so
    an unrestricted path there would let a config edit make SYSTEM write
    anywhere on the disk. Anything outside the logs folder is refused with a
    warning and the default applies. The environment variable is not guarded:
    it is set by whoever launches the process, such as the GUI for its child.
    """
    if candidate is None:
        return default_log_file()
    logs_dir = default_log_dir()
    try:
        if Path(str(candidate)).resolve().is_relative_to(logs_dir.resolve()):
            return str(candidate)
    except OSError:
        pass
    print(
        f"[run_server] WARNING: ignoring config log_file {candidate!r}: it is outside {logs_dir}",
        file=sys.stderr,
    )
    return default_log_file()


# ---------------------------------------------------------------------------
# Environment wiring (applied before importing the heavy app/transcribe stack)
# ---------------------------------------------------------------------------


def apply_environment(config: ServerConfig) -> None:
    """Export resolved config into the process environment.

    The app reads MEDIA_ROOT / HF_HOME / SUBSMELT_FFMPEG / SUBSMELT_NEMO_SPEECH /
    SUBSMELT_WHISPER_TOKEN directly from ``os.environ`` (see app/main.py, app/audio.py). We set them here
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
    if config.nemo_speech:
        os.environ["SUBSMELT_NEMO_SPEECH"] = config.nemo_speech
    if config.version:
        # app/version.py reads this for /health; the installer stamps it into
        # config.json, where the service sees it without a reboot.
        os.environ["SUBSMELT_WHISPER_VERSION"] = config.version


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
    candidates = [base, base / "nvidia" / "cudnn" / "bin", base / "nvidia" / "cublas" / "bin"]
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


def verify_metal_runtime() -> tuple[bool, str]:
    """The macOS counterpart of the CUDA probe: Metal is reached only through
    the bundled nemo-speech, so its version is what the startup line reports."""
    from app.nemotron_runtime import binary_version

    version = binary_version()
    if version is None:
        return False, "nemo-speech runtime not found — Nemotron is unavailable; Whisper runs on the CPU."
    return True, f"nemo-speech {version} on Metal — Nemotron runs on the GPU; Whisper runs on the CPU."


def verify_accelerator(platform: str | None = None) -> tuple[bool, str]:
    if (platform or sys.platform) == "darwin":
        return verify_metal_runtime()
    return verify_cuda_runtime()


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
    parser.add_argument(
        "--generate-token",
        action="store_true",
        help="Print a new backend API key to paste into SubSmelt, then exit.",
    )
    parser.add_argument(
        "--save",
        action="store_true",
        help="With --generate-token: also write the key into config.json.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="With --generate-token --save: replace an existing stored token.",
    )
    parser.add_argument(
        "--service",
        action="store_true",
        help="Run under the Windows Service Control Manager (used by the service's binPath).",
    )
    return parser.parse_args(argv)


def exposure_warnings(config: ServerConfig) -> list[str]:
    """Warn when the server is reachable off-box without a token.

    The default bind is 0.0.0.0 so a containerised or remote SubSmelt can reach
    the backend. That means an unconfigured install answers to the whole LAN, so
    say it plainly rather than leaving it to be discovered.
    """
    if config.host == LOOPBACK_HOST or config.token:
        return []
    return [
        f"[run_server] WARNING: listening on {config.host} with NO token — every "
        "host on this network can use this backend.",
        "[run_server] WARNING: set SUBSMELT_WHISPER_TOKEN (or bind "
        f"SUBSMELT_WHISPER_HOST={LOOPBACK_HOST}) to lock it down.",
    ]


#: Where the generated key is pasted on the SubSmelt side. Named in full so the
#: operator does not have to go hunting through Settings for it.
PASTE_LOCATION = "SubSmelt → Settings → Speech to Text → Backend token"


def generate_token_command(save: bool, force: bool) -> int:
    """Mint a backend API key, print it, and optionally store it.

    The headless installs — Windows service, Docker, plain CLI — have no control
    window, and every hardening message so far ended at "set
    SUBSMELT_WHISPER_TOKEN", which asks the operator to invent a secret. This
    produces one instead, and tells them where it goes.

    Printing is the default and is side-effect free. ``--save`` writes it to
    config.json, and refuses to overwrite a token already stored there without
    ``--force``: rotating the key is a legitimate operation, but doing it by
    accident 401s every client that was working a moment ago.
    """
    # Every refusal is checked BEFORE a key is minted. Printing a key and then
    # refusing to store it reads as "here is your key — error" and invites the
    # operator to use a value the backend never accepted.
    config_path = resolve_config_path() if save else None
    if force and not save:
        print(
            "[run_server] ERROR: --force only means something with --save (it "
            "guards replacing a stored token). Nothing was changed.",
            file=sys.stderr,
        )
        return 2
    if save and not force:
        existing = str(_load_config_file(config_path).get("token") or "").strip()
        if existing:
            print(
                f"[run_server] ERROR: {config_path} already stores a token. "
                "Replacing it will make every client using the old one fail "
                "with 401. Re-run with --force if that is what you want. "
                "Nothing was changed.",
                file=sys.stderr,
            )
            return 1

    token = generate_token()
    print(f"\nBackend API key:\n\n    {token}\n")
    print(f"Paste it into {PASTE_LOCATION}.")

    if not save:
        print(
            "It has NOT been saved. Store it on the backend too — either "
            "re-run with --save, or set SUBSMELT_WHISPER_TOKEN=<key>.\n"
        )
        return 0

    try:
        write_config_token(config_path, token)
    except OSError as exc:
        print(f"\n[run_server] ERROR: could not write {config_path}: {exc}", file=sys.stderr)
        return 1

    print(f"Saved to {config_path}. Restart the backend to apply it.")
    if (os.environ.get("SUBSMELT_WHISPER_TOKEN") or "").strip():
        # Env beats file in load_config, so the saved key would not be the one
        # actually enforced — say so rather than leaving it to a 401 later.
        print(
            "\nWARNING: SUBSMELT_WHISPER_TOKEN is set in the environment and "
            "takes precedence over config.json. The backend will keep using "
            "that value until it is cleared."
        )
    return 0


def configure_file_logging(config: ServerConfig) -> bool:
    """Attach a rotating file handler when SUBSMELT_WHISPER_LOG_FILE is set.

    Windows services have no console, so log to a file (plan Phase 5). The handler
    is attached to the root logger plus uvicorn's loggers, and uvicorn is later
    told NOT to reset logging (``log_config=None``) so these handlers survive.
    Rotation: 5 MB × 5 backups. Returns True when file logging was enabled.
    """

    # Record the outcome either way so /health (and therefore the control GUI
    # and the SubSmelt app) can say whether logging is actually on. Without this
    # a failure is silent: the warning below goes to a stderr that a Windows
    # service, and the GUI's CREATE_NO_WINDOW child, do not have.
    def _record(active: bool, error: str | None = None) -> None:
        try:
            from app.log_state import set_log_state

            set_log_state(config.log_file, active, error)
        except Exception:  # pragma: no cover - diagnostics must never be fatal
            pass

    if not config.log_file:
        _record(False, "no log file configured")
        return False
    import logging
    from logging.handlers import RotatingFileHandler

    try:
        log_path = Path(config.log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        level = getattr(logging, config.log_level.upper(), logging.INFO)
        root = logging.getLogger()
        root.setLevel(level)
        root.addHandler(handler)
        # Root only. uvicorn's loggers propagate to root, so a handler on them
        # as well wrote every line three times on the installed service.
        for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
            lg = logging.getLogger(name)
            lg.setLevel(level)
            lg.propagate = True
        print(f"[run_server] file logging → {log_path} (level={config.log_level})")
        _record(True)
        return True
    except OSError as exc:
        # Never refuse to start over a logging-path problem; warn and use console.
        print(f"[run_server] WARNING: could not open log file {config.log_file}: {exc}", file=sys.stderr)
        _record(False, str(exc))
        return False


def tolerate_unencodable_output() -> None:
    """Never crash on a status line: a redirected Windows stdout uses the ANSI
    code page, which cannot encode characters such as the arrow below."""
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")


def prepare_runtime(config: ServerConfig) -> tuple[bool, bool, str]:
    """Everything between a resolved config and starting uvicorn: environment,
    DLL search path, file logging, the GPU probe. Shared by the console
    launcher and the Windows service so the two cannot drift.

    Returns (file_logging, gpu_ok, gpu_message).
    """
    apply_environment(config)
    add_bundled_dll_dir()
    file_logging = configure_file_logging(config)
    gpu_ok, message = verify_accelerator()
    print(f"[run_server] {message}")
    return file_logging, gpu_ok, message


def uvicorn_kwargs(config: ServerConfig, file_logging: bool) -> dict:
    """Arguments for ``uvicorn.run`` and ``uvicorn.Config`` alike.

    reload is off on purpose for a service. With a file handler installed,
    uvicorn is told NOT to reset logging (``log_config=None``) so the rotating
    handler stays attached; otherwise its default console logging applies.
    """
    kwargs = {
        "host": config.host,
        "port": config.port,
        "log_level": config.log_level,
        "reload": False,
    }
    if file_logging:
        kwargs["log_config"] = None
    return kwargs


def main(argv: list[str] | None = None) -> int:
    tolerate_unencodable_output()
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    # Before load_config()/apply_environment(): minting a key must work on an
    # install that is not yet startable, and must never touch the environment.
    if args.generate_token:
        return generate_token_command(save=args.save, force=args.force)
    if args.save or args.force:
        print("[run_server] --save/--force only apply to --generate-token.", file=sys.stderr)
        return 2

    if args.service:
        # The Service Control Manager calls back into winservice, which loads
        # config and prepares the runtime itself once the service is RUNNING.
        import winservice

        return winservice.run_as_service()

    config = load_config()

    if args.print_config:
        print(json.dumps(config.redacted(), indent=2))
        return 0

    file_logging, gpu_ok, _message = prepare_runtime(config)

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

    print(f"[run_server] starting uvicorn on {config.host}:{config.port} (gpu={'yes' if gpu_ok else 'no'})")
    for line in exposure_warnings(config):
        print(line, file=sys.stderr)
    # Pass the import string (not the app object) so uvicorn owns the lifecycle.
    uvicorn.run("app.main:app", **uvicorn_kwargs(config, file_logging))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
