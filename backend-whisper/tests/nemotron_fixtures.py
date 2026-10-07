"""Shared helpers for the Nemotron tests: a wrapper that execs the fake
nemo-speech, a seeded GGUF in the HF cache layout, and a silent 16 kHz WAV."""

import os
import stat
import sys
import wave
from pathlib import Path

FAKE_BINARY = Path(__file__).resolve().parent / "fake_nemo_speech.py"
GGUF_NAME = "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf"
REPO_DIR = "models--nvidia--nemotron-3.5-asr-streaming-0.6b"


def write_fake_binary(directory: Path) -> Path:
    """A shell wrapper so the fake resolves like a real executable."""
    wrapper = directory / "nemo-speech"
    wrapper.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_BINARY}" "$@"\n', encoding="utf-8")
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return wrapper


def seed_gguf(hf_home: Path, revision: str = "abc123") -> Path:
    snapshot = hf_home / "hub" / REPO_DIR / "snapshots" / revision
    snapshot.mkdir(parents=True, exist_ok=True)
    gguf = snapshot / GGUF_NAME
    gguf.write_bytes(b"GGUF")
    return gguf


def write_silent_wav(path: Path, seconds: float, rate: int = 16000) -> Path:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\0\0" * int(seconds * rate))
    return path


def can_exec_wrappers() -> bool:
    return os.name != "nt"
