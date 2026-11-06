"""Best-effort storage for reusable recognition output, before subtitle processing."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
import threading
import time
from collections.abc import Callable
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

from pydantic import BaseModel, ConfigDict

from .catalog import descriptor_for
from .engine import TranscriptionCancelled
from .gpu import effective_compute_type, effective_device
from .model_cache import cache_root_from_env
from .nemotron_languages import map_language, normalize_language
from .schemas import TranscribeRequest
from .version import backend_version
from .whisper_engine import faster_whisper_transcribe_kwargs

# Bump this when recognition output or its stored representation changes.
_FORMAT_VERSION = 1
_MAX_AGE_S = 30 * 24 * 60 * 60
_MAX_FILES = 128
_MAX_BYTES = 256 * 1024 * 1024
_MAX_ENTRY_BYTES = 32 * 1024 * 1024
_ENTRY_NAME = re.compile(r"v\d+-[a-f0-9]{64}\.json")
_LOCK = threading.Lock()
log = logging.getLogger(__name__)


class _StoredModel(BaseModel):
    model_config = ConfigDict(strict=True, allow_inf_nan=False)


class RawWord(_StoredModel):
    text: str
    start: float | None
    end: float | None

    @classmethod
    def from_word(cls, word: object) -> RawWord:
        return cls(
            text=getattr(word, "word", getattr(word, "text", "")),
            start=getattr(word, "start", None),
            end=getattr(word, "end", None),
        )


class RawSegment(_StoredModel):
    text: str
    start: float
    end: float
    words: list[RawWord]

    @classmethod
    def from_segment(cls, segment: object) -> RawSegment:
        return cls(
            text=segment.text,
            start=segment.start,
            end=segment.end,
            words=[RawWord.from_word(word) for word in (getattr(segment, "words", None) or ())],
        )


class RawTranscript(_StoredModel):
    version: Literal[1]
    key: str
    engine: str
    language: str | None
    duration: float | None
    segments: list[RawSegment]
    words: list[RawWord] | None

    @classmethod
    def from_output(cls, key: str, engine: str, segments: list, info: object) -> RawTranscript:
        words = getattr(info, "raw_words", None)
        raw_segments = getattr(info, "raw_segments", segments) if words is None else []
        return cls(
            version=_FORMAT_VERSION,
            key=key,
            engine=engine,
            language=getattr(info, "language", None),
            duration=getattr(info, "duration", None),
            segments=[RawSegment.from_segment(segment) for segment in raw_segments],
            words=None if words is None else [RawWord.from_word(word) for word in words],
        )

    def output(self) -> tuple[list, object]:
        info = SimpleNamespace(language=self.language, duration=self.duration)
        if self.words is not None:
            info.raw_words = self.words
        else:
            info.raw_segments = self.segments
        return self.segments, info


def checkpoint_directory() -> Path | None:
    if os.environ.get("SUBSMELT_WHISPER_CHECKPOINTS") == "0":
        return None
    override = os.environ.get("SUBSMELT_WHISPER_CHECKPOINT_DIR")
    return Path(override).expanduser() if override else cache_root_from_env() / "subsmelt-transcripts"


def content_digest(path: Path, is_cancelled: Callable[[], bool] | None) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            if is_cancelled and is_cancelled():
                raise TranscriptionCancelled("Transcription cancelled by client")
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache
def _package_version(package: str) -> str | None:
    try:
        return version(package)
    except PackageNotFoundError:
        return None


def _decode_options(request: TranscribeRequest, engine: str) -> dict:
    if engine == "whisper":
        return {
            **faster_whisper_transcribe_kwargs(request),
            "device": effective_device(request.device),
            "compute_type": effective_compute_type(request.compute_type),
            "runtime": [_package_version("faster-whisper"), _package_version("ctranslate2")],
        }
    if engine == "nemotron":
        return {
            "language": map_language(request.language),
            "device": "cuda" if effective_device(request.device) == "cuda" else "auto",
        }
    options = request.advanced_options
    return {
        "language": normalize_language(request.language) or "auto",
        "initial_prompt": (options.initial_prompt or None) if options else None,
        "beam_size": options.beam_size if options else None,
    }


def checkpoint_key(
    request: TranscribeRequest,
    engine: str,
    input_identity: tuple | str,
    model_identity: tuple,
    extractor_identity: tuple | None,
) -> str:
    identity = {
        "version": _FORMAT_VERSION,
        "backend": backend_version(),
        "input": input_identity,
        "extractor": extractor_identity,
        "engine": engine,
        "model": request.model,
        "weights": model_identity,
        "audio_stream": request.audio_stream_index,
        "packed_source_stream": request.source_audio_stream_index,
        "decode": _decode_options(request, engine),
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def recognizer_engine(request: TranscribeRequest) -> str:
    descriptor = descriptor_for(request.model)
    return descriptor.engine if descriptor else "whisper"


def read_checkpoint(directory: Path, key: str, engine: str) -> RawTranscript | None:
    artifact = directory / f"v{_FORMAT_VERSION}-{key}.json"
    try:
        stat = artifact.stat()
        if time.time() - stat.st_mtime > _MAX_AGE_S or stat.st_size > _MAX_ENTRY_BYTES:
            return None
        with artifact.open("rb") as source:
            raw = source.read(_MAX_ENTRY_BYTES + 1)
        if len(raw) > _MAX_ENTRY_BYTES:
            return None
        transcript = RawTranscript.model_validate_json(raw)
        if transcript.key != key or transcript.engine != engine:
            return None
        return transcript
    except (OSError, ValueError):
        return None


def write_checkpoint(directory: Path, transcript: RawTranscript) -> None:
    tmp = None
    try:
        data = transcript.model_dump_json().encode()
        if len(data) > _MAX_ENTRY_BYTES:
            return
        with _LOCK:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=directory, prefix=".raw-", suffix=".tmp", delete=False) as output:
                tmp = Path(output.name)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            tmp.replace(directory / f"v{_FORMAT_VERSION}-{transcript.key}.json")
            _prune(directory)
    except (OSError, ValueError):
        log.warning("Raw transcript checkpoint could not be saved", exc_info=True)
    finally:
        if tmp is not None:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass


def _prune(directory: Path) -> None:
    now = time.time()
    entries = []
    for artifact in directory.iterdir():
        try:
            if _ENTRY_NAME.fullmatch(artifact.name):
                stat = artifact.stat()
                entries.append((stat.st_mtime, stat.st_size, artifact))
            elif (
                artifact.name.startswith(".raw-")
                and artifact.suffix == ".tmp"
                and now - artifact.stat().st_mtime > _MAX_AGE_S
            ):
                artifact.unlink(missing_ok=True)
        except OSError:
            continue
    total = 0
    for index, (mtime, size, artifact) in enumerate(sorted(entries, reverse=True)):
        total += size
        if index >= _MAX_FILES or total > _MAX_BYTES or now - mtime > _MAX_AGE_S:
            try:
                artifact.unlink(missing_ok=True)
            except OSError:
                pass
