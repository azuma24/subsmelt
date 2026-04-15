"""
Runtime configuration for the subsmelt-whisper backend.

Resolution order (highest wins):
    1. Environment variables
    2. config.ini (created on first run)
    3. Built-in defaults

On first run, a random API key is generated and persisted to ``config.ini``.
The generated key is logged once in a clearly delimited banner. Subsequent
starts never re-log the key.
"""

from __future__ import annotations

import configparser
import logging
import os
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

DEFAULT_MEDIA_DIR = "/media"
DEFAULT_MODELS_DIR = "/models"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 9000
DEFAULT_DEVICE = "auto"             # "auto" | "cuda" | "cpu"
DEFAULT_COMPUTE_TYPE = "float16"    # "float16" | "int8_float16" | "int8" | "float32"
DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_MAX_CONCURRENT = 1          # GPU is typically the bottleneck


def _default_config_dir() -> Path:
    """Platform-appropriate default config dir (overridable by CONFIG_DIR env)."""
    override = os.environ.get("CONFIG_DIR")
    if override:
        return Path(override)
    if sys.platform.startswith("win"):
        program_data = os.environ.get("ProgramData", r"C:\ProgramData")
        return Path(program_data) / "SubsmeltWhisper"
    return Path("/config")


@dataclass
class Settings:
    media_dir: Path
    models_dir: Path
    host: str
    port: int
    api_key: str
    device: str
    compute_type: str
    log_level: str
    max_concurrent: int
    config_dir: Path

    # Set to True on first startup after auto-generating the key so main.py can
    # print a one-time banner without re-logging on subsequent runs.
    api_key_was_generated: bool = field(default=False, repr=False)

    @property
    def config_file(self) -> Path:
        return self.config_dir / "config.ini"

    @property
    def first_run_log(self) -> Path:
        return self.config_dir / "first-run.log"

    @property
    def auth_disabled(self) -> bool:
        return self.api_key == ""


def _coerce_int(value: str, fallback: int) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return fallback


def _resolve(ini: configparser.ConfigParser, section: str, key: str, env: str, default: str) -> str:
    if env in os.environ and os.environ[env] != "":
        return os.environ[env]
    if ini.has_section(section) and ini.get(section, key, fallback="").strip():
        return ini.get(section, key)
    return default


def load_settings() -> Settings:
    """Load settings, creating `config.ini` with a fresh API key on first run."""
    config_dir = _default_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)
    config_file = config_dir / "config.ini"

    ini = configparser.ConfigParser()
    if config_file.exists():
        ini.read(config_file, encoding="utf-8")

    for section in ("server", "runtime", "paths"):
        if not ini.has_section(section):
            ini.add_section(section)

    # --- paths ---
    media_dir = Path(_resolve(ini, "paths", "media_dir", "MEDIA_DIR", DEFAULT_MEDIA_DIR))
    models_dir = Path(_resolve(ini, "paths", "models_dir", "MODELS_DIR", DEFAULT_MODELS_DIR))

    # --- server ---
    host = _resolve(ini, "server", "host", "HOST", DEFAULT_HOST)
    port = _coerce_int(_resolve(ini, "server", "port", "PORT", str(DEFAULT_PORT)), DEFAULT_PORT)

    api_key = _resolve(ini, "server", "api_key", "API_KEY", "")
    api_key_was_generated = False
    # Only auto-generate if the config file doesn't exist yet AND no env key is set.
    # An empty api_key on an existing config means "auth disabled" (intentional).
    if not config_file.exists() and "API_KEY" not in os.environ:
        api_key = secrets.token_urlsafe(32)
        api_key_was_generated = True

    # --- runtime ---
    device = _resolve(ini, "runtime", "device", "DEVICE", DEFAULT_DEVICE)
    compute_type = _resolve(ini, "runtime", "compute_type", "COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE)
    log_level = _resolve(ini, "runtime", "log_level", "LOG_LEVEL", DEFAULT_LOG_LEVEL)
    max_concurrent = _coerce_int(
        _resolve(ini, "runtime", "max_concurrent", "MAX_CONCURRENT", str(DEFAULT_MAX_CONCURRENT)),
        DEFAULT_MAX_CONCURRENT,
    )

    # Persist resolved values back so config.ini is always readable / editable.
    ini.set("paths", "media_dir", str(media_dir))
    ini.set("paths", "models_dir", str(models_dir))
    ini.set("server", "host", host)
    ini.set("server", "port", str(port))
    ini.set("server", "api_key", api_key)
    ini.set("runtime", "device", device)
    ini.set("runtime", "compute_type", compute_type)
    ini.set("runtime", "log_level", log_level)
    ini.set("runtime", "max_concurrent", str(max_concurrent))

    with config_file.open("w", encoding="utf-8") as fh:
        ini.write(fh)

    media_dir.mkdir(parents=True, exist_ok=True)
    models_dir.mkdir(parents=True, exist_ok=True)

    settings = Settings(
        media_dir=media_dir,
        models_dir=models_dir,
        host=host,
        port=port,
        api_key=api_key,
        device=device,
        compute_type=compute_type,
        log_level=log_level,
        max_concurrent=max_concurrent,
        config_dir=config_dir,
        api_key_was_generated=api_key_was_generated,
    )
    return settings


def rotate_api_key(settings: Settings) -> str:
    """Generate + persist a fresh API key. Returns the new key."""
    new_key = secrets.token_urlsafe(32)
    ini = configparser.ConfigParser()
    if settings.config_file.exists():
        ini.read(settings.config_file, encoding="utf-8")
    if not ini.has_section("server"):
        ini.add_section("server")
    ini.set("server", "api_key", new_key)
    with settings.config_file.open("w", encoding="utf-8") as fh:
        ini.write(fh)
    settings.api_key = new_key
    return new_key


def log_first_run_banner(settings: Settings) -> None:
    """Print the generated key once. Called from the app lifespan on first start."""
    if not settings.api_key_was_generated:
        return
    banner = (
        "\n"
        "================================================================\n"
        " Subsmelt Whisper backend — generated API key on first start:\n"
        "\n"
        f"   {settings.api_key}\n"
        "\n"
        f" Saved to: {settings.config_file}\n"
        " Paste this into Subsmelt → Settings → Transcription → API key.\n"
        "================================================================\n"
    )
    print(banner, flush=True)
    try:
        settings.first_run_log.write_text(banner, encoding="utf-8")
    except OSError:
        pass


# Loaded once at import-time so FastAPI dependencies can read it cheaply.
_SETTINGS: Optional[Settings] = None


def get_settings() -> Settings:
    global _SETTINGS
    if _SETTINGS is None:
        _SETTINGS = load_settings()
    return _SETTINGS
