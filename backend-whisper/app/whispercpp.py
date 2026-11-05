"""The whisper.cpp engine runner: ``whisper-cli`` as one child process per
transcription. The binary picks Metal itself; progress arrives on stderr and
the finished transcript as one JSON document beside a ``-of`` prefix."""

from __future__ import annotations

import codecs
import json
import math
import re
import select
import subprocess
import tempfile
import wave
from collections.abc import Callable, Generator
from pathlib import Path
from types import SimpleNamespace

from .engine import TranscriptionCancelled, progress_event
from .model_loader import lease
from .nemotron_languages import normalize_language
from .schemas import TranscribeRequest
from .segments import has_wide_chars, snap_start_to_words
from .whispercpp_runtime import WhisperCppHandle
from .word_timing import Word

POLL_S = 0.2
# Child output is decoded as UTF-8 whatever the locale: whisper-cli echoes file
# paths, and a non-ASCII temp path in the system codepage would otherwise abort
# the run with a decode error instead of a transcript.
_TEXT_OUTPUT = {"text": True, "encoding": "utf-8", "errors": "replace"}

_PROGRESS = re.compile(r"progress\s*=\s*([0-9.]+)\s*%")


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wav:
        return wav.getnframes() / wav.getframerate()


def _command(handle: WhisperCppHandle, wav: Path, language: str, out_prefix: Path, options) -> list[str]:
    command = [
        str(handle.binary),
        "-m",
        str(handle.weights),
        "-f",
        str(wav),
        "-l",
        language,
        "-ojf",
        "-pp",
        "-of",
        str(out_prefix),
    ]
    if options:
        if options.initial_prompt:
            command += ["--prompt", options.initial_prompt]
        if options.beam_size is not None:
            command += ["-bs", str(options.beam_size)]
    return command


def _stream_stderr(proc: subprocess.Popen, is_cancelled: Callable[[], bool] | None) -> Generator[float, None, str]:
    """Yield each progress percent the child prints; the generator's return
    value is the full stderr text.

    The reader waits on select with a timeout so a cancel is honoured within
    ``POLL_S`` even when the child prints nothing for a while. whisper-cli only
    runs where a POSIX shell does, so select is safe here.
    """
    chunks: list[str] = []
    stream = proc.stderr
    assert stream is not None
    while True:
        ready, _, _ = select.select([stream], [], [], POLL_S)
        if not ready:
            if is_cancelled is not None and is_cancelled():
                proc.kill()
                proc.communicate()
                raise TranscriptionCancelled("Transcription cancelled by client")
            continue
        line = stream.readline()
        if line:
            chunks.append(line)
            found = _PROGRESS.search(line)
            if found:
                yield float(found.group(1))
            continue
        break
    chunks.append(stream.read() or "")
    if is_cancelled is not None and is_cancelled():
        proc.kill()
        proc.communicate()
        raise TranscriptionCancelled("Transcription cancelled by client")
    proc.communicate()
    return "".join(chunks)


def _token_words(tokens: list, text: str) -> tuple[Word, ...]:
    """Join Latin subword tokens and retain boundaries for unspaced wide text."""
    if not isinstance(tokens, list):
        return ()
    words: list[Word] = []
    # whisper-cli writes token bytes directly. One UTF-8 code point can start
    # in one JSON string and finish in the next.
    decoder = codecs.getincrementaldecoder("utf-8")()
    pending_start = None
    last_start = 0
    try:
        for token in tokens:
            raw = token.get("text", "")
            if not raw or raw.startswith("[_"):
                continue
            offsets = token.get("offsets") or {}
            start, end = offsets.get("from"), offsets.get("to")
            if not (
                isinstance(start, (int, float))
                and isinstance(end, (int, float))
                and math.isfinite(start)
                and math.isfinite(end)
                and last_start <= start <= end
            ):
                return ()
            last_start = start
            start, end = start / 1000.0, end / 1000.0
            part = decoder.decode(raw.encode("utf-8", errors="surrogateescape"))
            part_start = start if pending_start is None else pending_start
            pending_start = (start if part else part_start) if decoder.getstate()[0] else None
            if not part:
                continue
            if (
                words
                and not words[-1].text[-1].isspace()
                and not part[0].isspace()
                and not has_wide_chars(words[-1].text[-1] + part[0])
            ):
                previous = words[-1]
                words[-1] = Word(previous.text + part, previous.start, max(previous.end, end))
            else:
                words.append(Word(part, part_start, end))
        decoder.decode(b"", final=True)
    except (AttributeError, UnicodeError):
        return ()
    if "".join(word.text for word in words).strip() != text.strip():
        return ()
    words = [word for word in words if word.text.strip()]
    return tuple(words) if any(word.end > word.start for word in words) else ()


def _segments_from(data: dict, *, with_words: bool) -> list:
    segments = []
    for item in data.get("transcription") or []:
        # Invalid UTF-8 within the segment text itself still has a displayable
        # fallback, even when its token strings could not be recovered.
        text = item.get("text", "").encode("utf-8", errors="surrogateescape").decode("utf-8", errors="replace")
        start, end = item["offsets"]["from"] / 1000.0, item["offsets"]["to"] / 1000.0
        words = _token_words(item.get("tokens") or [], text) if with_words else ()
        if any(word.start < start or word.end > end for word in words):
            words = ()
        segments.append(SimpleNamespace(start=start, end=end, text=text, words=words))
    return segments


def run(
    request: TranscribeRequest,
    audio_path: Path,
    is_cancelled: Callable[[], bool] | None,
    min_progress_interval: float,
) -> Generator[dict, None, tuple[list, object]]:
    """Engine runner for the ``whispercpp`` models."""
    language = normalize_language(request.language) or "auto"
    duration = wav_duration(audio_path)
    with lease(request.model, "", "") as handle:
        with tempfile.TemporaryDirectory(prefix="subsmelt-whispercpp-") as tmp:
            out_prefix = Path(tmp) / "out"
            command = _command(handle, audio_path, language, out_prefix, request.advanced_options)
            proc = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **_TEXT_OUTPUT)
            # Progress arrives as a percent of the audio; the pipeline expects
            # seconds, throttled to one event per min_progress_interval.
            last = -min_progress_interval
            stderr = ""
            stream = _stream_stderr(proc, is_cancelled)
            while True:
                try:
                    pct = next(stream)
                except StopIteration as done:
                    stderr = done.value or ""
                    break
                seconds = pct / 100.0 * duration
                if seconds - last >= min_progress_interval:
                    last = seconds
                    yield progress_event(seconds, duration)
            if proc.returncode != 0:
                raise RuntimeError(f"whisper-cli exited with code {proc.returncode}: {stderr.strip()[-500:]}")
            try:
                data = json.loads(Path(f"{out_prefix}.json").read_text(encoding="utf-8", errors="surrogateescape"))
            except (OSError, ValueError):
                raise RuntimeError(f"whisper-cli exited with code {proc.returncode} without a JSON result") from None
    result = data.get("result") or {}
    options = request.advanced_options
    explicit_word_timestamps = options.word_timestamps if options else None
    quality = request.subtitle_quality
    with_words = explicit_word_timestamps is True or (
        explicit_word_timestamps is None and quality is not None and (quality.max_subtitle_duration or 0) > 0
    )
    segments = _segments_from(data, with_words=with_words)
    if explicit_word_timestamps is True:
        segments = [snap_start_to_words(segment) for segment in segments]
    return segments, SimpleNamespace(language=result.get("language"), duration=duration)
