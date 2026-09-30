"""The Nemotron 3.5 ASR engine runner: nemo-speech as a subprocess per chunk.

nemo-speech prints one JSON document when a file is done and nothing before,
so long audio is cut at silences into chunks of about ten minutes; each
finished chunk is one progress line, and cancelling kills the running child.
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
import time
import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Generator, Sequence

from .audio import ffmpeg_binary
from .engine import TranscriptionCancelled, progress_event
from .model_loader import lease
from .nemotron_languages import map_language, short_code_for
from .nemotron_runtime import NemotronHandle
from .nemotron_words import Word, words_to_segments
from .schemas import TranscribeRequest

CHUNK_TARGET_S = 600.0
CHUNK_MAX_S = 720.0
CHUNK_SEARCH_S = 120.0
SILENCE_FILTER = "silencedetect=noise=-35dB:d=0.4"
POLL_S = 0.2

Chunk = tuple[float, float]
Silence = tuple[float, float]

_SILENCE_START = re.compile(r"silence_start:\s*([0-9.]+)")
_SILENCE_END = re.compile(r"silence_end:\s*([0-9.]+)")


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wav:
        return wav.getnframes() / wav.getframerate()


def parse_silences(ffmpeg_stderr: str) -> list[Silence]:
    silences: list[Silence] = []
    start: float | None = None
    for line in ffmpeg_stderr.splitlines():
        started = _SILENCE_START.search(line)
        ended = _SILENCE_END.search(line)
        if started:
            start = float(started.group(1))
        elif ended and start is not None:
            silences.append((start, float(ended.group(1))))
            start = None
    return silences


def detect_silences(audio_path: Path) -> list[Silence]:
    command = [ffmpeg_binary(), "-hide_banner", "-nostats", "-i", str(audio_path), "-af", SILENCE_FILTER, "-f", "null", "-"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    return parse_silences(result.stderr or "")


def _cut_point(target: float, silences: Sequence[Silence]) -> float:
    """Middle of the longest silence within ``CHUNK_SEARCH_S`` of the target."""
    low, high = target - CHUNK_SEARCH_S, target + CHUNK_SEARCH_S
    inside = [(end - start, start, end) for start, end in silences if start >= low and end <= high]
    if not inside:
        return target
    _, start, end = max(inside)
    return (start + end) / 2


def plan_chunks(duration: float, silences: Callable[[], Sequence[Silence]]) -> list[Chunk]:
    """One chunk up to ``CHUNK_MAX_S``; beyond that, a cut near every multiple
    of ``CHUNK_TARGET_S``. ``silences`` is only consulted when cutting."""
    if duration <= CHUNK_MAX_S:
        return [(0.0, duration)]
    found = silences()
    targets = [CHUNK_TARGET_S * index for index in range(1, int(duration // CHUNK_TARGET_S) + 1) if CHUNK_TARGET_S * index < duration]
    bounds = [0.0, *(_cut_point(target, found) for target in targets), duration]
    return list(zip(bounds, bounds[1:]))


def cut_chunk(source: Path, chunk: Chunk, dest_dir: Path, index: int) -> Path:
    start, end = chunk
    target = dest_dir / f"chunk-{index:03d}.wav"
    with wave.open(str(source), "rb") as src:
        rate = src.getframerate()
        src.setpos(int(start * rate))
        frames = src.readframes(int((end - start) * rate))
        with wave.open(str(target), "wb") as dst:
            dst.setparams(src.getparams())
            dst.writeframes(frames)
    return target


def _cli_device(request: TranscribeRequest) -> str:
    return "cuda" if (request.device or "").strip().lower() == "cuda" else "auto"


def _wait_or_kill(proc: subprocess.Popen, is_cancelled: Callable[[], bool] | None) -> tuple[str, str]:
    """Poll the child; when the caller cancels, kill it and raise."""
    while True:
        try:
            return proc.communicate(timeout=POLL_S)
        except subprocess.TimeoutExpired:
            if is_cancelled is not None and is_cancelled():
                proc.kill()
                proc.communicate()
                raise TranscriptionCancelled("Transcription cancelled by client")


def _parse_output(stdout: str, stderr: str, returncode: int) -> dict:
    try:
        data = json.loads(stdout)
    except ValueError:
        detail = (stderr or stdout).strip()[-500:]
        raise RuntimeError(f"nemo-speech exited with code {returncode} without a JSON result: {detail}")
    if isinstance(data, dict) and "error" in data:
        error = data["error"] if isinstance(data["error"], dict) else {}
        raise RuntimeError(f"nemo-speech failed: {error.get('message') or data['error']}")
    if returncode != 0:
        raise RuntimeError(f"nemo-speech exited with code {returncode}")
    return data


def transcribe_chunk(
    handle: NemotronHandle,
    wav: Path,
    locale: str,
    device: str,
    is_cancelled: Callable[[], bool] | None,
) -> dict:
    command = [
        str(handle.binary), "transcribe", str(wav),
        "--model", str(handle.gguf), "--language", locale,
        "--json", "--quiet", "--device", device,
    ]
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    stdout, stderr = _wait_or_kill(proc, is_cancelled)
    return _parse_output(stdout, stderr, proc.returncode)


def _offset_words(raw_words: Sequence[dict], offset: float) -> list[Word]:
    return [
        Word(text=str(item.get("word", "")), start=float(item.get("start", 0.0)) + offset, end=float(item.get("end", 0.0)) + offset)
        for item in raw_words
    ]


def run_chunks(
    handle: NemotronHandle,
    audio_path: Path,
    chunks: Sequence[Chunk],
    duration: float,
    locale: str,
    device: str,
    is_cancelled: Callable[[], bool] | None,
) -> Generator[dict, None, tuple[list[Word], list[str]]]:
    """Transcribe each chunk in turn, yielding one progress line per chunk and
    returning the offset words and the locales the model reported."""
    words: list[Word] = []
    locales: list[str] = []
    with tempfile.TemporaryDirectory(prefix="subsmelt-nemo-") as tmp:
        for index, chunk in enumerate(chunks):
            if is_cancelled is not None and is_cancelled():
                raise TranscriptionCancelled("Transcription cancelled by client")
            wav = audio_path if len(chunks) == 1 else cut_chunk(audio_path, chunk, Path(tmp), index)
            data = transcribe_chunk(handle, wav, locale, device, is_cancelled)
            words.extend(_offset_words(data.get("words") or [], chunk[0]))
            locales.extend(data.get("languages") or [])
            yield progress_event(chunk[1], duration)
    return words, locales


def run(
    request: TranscribeRequest,
    audio_path: Path,
    is_cancelled: Callable[[], bool] | None,
    min_progress_interval: float,
) -> Generator[dict, None, tuple[list, object]]:
    """Engine runner for ``nemotron-3.5-asr``."""
    locale = map_language(request.language)
    with lease(request.model, request.device, request.compute_type) as handle:
        duration = wav_duration(audio_path)
        chunks = plan_chunks(duration, lambda: detect_silences(audio_path))
        words, locales = yield from run_chunks(
            handle, audio_path, chunks, duration, locale, _cli_device(request), is_cancelled
        )
    segments = words_to_segments(words, request.subtitle_quality)
    language = short_code_for(locales[0]) if locales else None
    return segments, SimpleNamespace(language=language, duration=duration)
