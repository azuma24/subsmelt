from __future__ import annotations

import os
import threading
from dataclasses import replace
from itertools import groupby
from types import SimpleNamespace
from typing import Any

from .gpu import cuda_device_count
from .model_loader import free_device_cache
from .secret_file import SecretFileError, secret_from_env
from .segments import Segment, normalize_segments
from .word_timing import Word

# Gated pyannote pipeline (requires HF token + accepted license).
DIARIZATION_MODEL = "pyannote/speaker-diarization-3.1"

# At most one pipeline resident, keyed by torch device (mirrors model_loader:
# loading for the other device releases the current one and its VRAM).
_PIPELINE_CACHE: dict[str, Any] = {}
_CACHE_LOCK = threading.Lock()


class DiarizationUnavailableError(RuntimeError):
    """pyannote.audio is not installed in this backend."""


class DiarizationTokenMissingError(RuntimeError):
    """No Hugging Face token configured (or it lacks access) for the gated model."""


def _hf_token() -> str:
    return (secret_from_env("SUBSMELT_HF_TOKEN") or os.environ.get("HF_TOKEN") or "").strip()


def diarize_available() -> bool:
    """True when diarization can actually run: pyannote importable AND a token set.

    Used to advertise capabilities.speakerDiarization honestly so the frontend
    only offers the toggle when the backend can fulfil it.
    """
    try:
        if not _hf_token():
            return False
        import pyannote.audio  # type: ignore  # noqa: F401
    except Exception:
        return False
    return True


def _resolve_torch_device(device: str) -> str:
    want = (device or "cpu").strip().lower()
    if want == "cuda" and cuda_device_count() > 0:
        return "cuda"
    return "cpu"


def _get_pipeline(device: str) -> Any:
    try:
        token = _hf_token()
    except SecretFileError as exc:
        raise DiarizationTokenMissingError(str(exc)) from None
    if not token:
        raise DiarizationTokenMissingError(
            "Speaker diarization needs a Hugging Face token; set SUBSMELT_HF_TOKEN or SUBSMELT_HF_TOKEN_FILE "
            "and accept the pyannote/speaker-diarization-3.1 license"
        )
    torch_device = _resolve_torch_device(device)
    cached = _PIPELINE_CACHE.get(torch_device)
    if cached is not None:
        return cached
    with _CACHE_LOCK:
        cached = _PIPELINE_CACHE.get(torch_device)
        if cached is not None:
            return cached
        try:
            import torch  # type: ignore
            from pyannote.audio import Pipeline  # type: ignore
        except Exception as exc:
            raise DiarizationUnavailableError("pyannote.audio is not installed in this backend") from exc
        pipeline = Pipeline.from_pretrained(DIARIZATION_MODEL, use_auth_token=token)
        if pipeline is None:
            # from_pretrained returns None when the token cannot access the gated repo.
            raise DiarizationTokenMissingError(
                "Could not load the diarization pipeline; the HF token may lack access "
                "— accept the pyannote/speaker-diarization-3.1 license and retry"
            )
        pipeline.to(torch.device(torch_device))
        # pyannote has no explicit unload: drop the other device's pipeline,
        # then free the CUDA cache once nothing references it. A diarization
        # still running on it keeps its own reference until it finishes.
        _PIPELINE_CACHE.clear()
        free_device_cache()
        _PIPELINE_CACHE[torch_device] = pipeline
        return pipeline


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _label_for(start: float, end: float, turns: list[tuple[float, float, str]]) -> str | None:
    """Speaker label whose turn overlaps [start, end] the most (None if no overlap)."""
    best_label: str | None = None
    best = 0.0
    for t0, t1, label in turns:
        ov = _overlap(start, end, t0, t1)
        if ov > best:
            best = ov
            best_label = label
    return best_label


def _turns_from_annotation(annotation: Any) -> list[tuple[float, float, str]]:
    turns: list[tuple[float, float, str]] = []
    for turn, _, label in annotation.itertracks(yield_label=True):
        turns.append((float(turn.start), float(turn.end), str(label)))
    return turns


def _copy_segment(seg: Any, speaker: str | None) -> SimpleNamespace:
    # faster-whisper Segments are immutable NamedTuples, so copy to a mutable
    # SimpleNamespace carrying the speaker (formatters read .start/.end/.text).
    return SimpleNamespace(
        start=float(getattr(seg, "start", 0.0) or 0.0),
        end=float(getattr(seg, "end", 0.0) or 0.0),
        text=getattr(seg, "text", "") or "",
        words=getattr(seg, "words", None),
        speaker=speaker,
    )


def _assign_timed_speakers(segment: Segment, turns: list[tuple[float, float, str]]) -> list[Segment]:
    overlapping = [turn for turn in turns if turn[0] < segment.end and turn[1] > segment.start]
    speaker = _label_for(segment.start, segment.end, overlapping)
    if not segment.words:
        return [replace(segment, speaker=speaker)]

    def word_speaker(word: Word) -> str | None:
        return _label_for(word.start, word.end, overlapping) or speaker

    groups = [(label, tuple(words)) for label, words in groupby(segment.words, key=word_speaker)]
    if len(groups) == 1:
        return [replace(segment, speaker=groups[0][0])]
    return [
        Segment(words[0].start, words[-1].end, "".join(word.text for word in words), label, words)
        for label, words in groups
    ]


def assign_speakers(
    segments: list,
    audio_path: Any,
    device: str,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
    *,
    split_on_speakers: bool = False,
) -> list:
    """Return new segments tagged with a ``speaker`` by max time-overlap.

    Runs the pyannote pipeline over the full audio (a post-pass), then labels
    each whisper segment with the diarized speaker it overlaps most. With word
    timing, the quality pass can also split a segment at a speaker change.
    """
    pipeline = _get_pipeline(device)
    kwargs: dict[str, int] = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers
    annotation = pipeline(str(audio_path), **kwargs)
    turns = _turns_from_annotation(annotation)
    if split_on_speakers:
        return [cue for segment in normalize_segments(segments) for cue in _assign_timed_speakers(segment, turns)]
    return [
        _copy_segment(
            seg,
            _label_for(
                float(getattr(seg, "start", 0.0) or 0.0),
                float(getattr(seg, "end", 0.0) or 0.0),
                turns,
            ),
        )
        for seg in segments
    ]


def fake_assign_speakers(segments: list) -> list:
    """Test double: alternate SPEAKER_00/SPEAKER_01 without pyannote/torch."""
    return [_copy_segment(seg, f"SPEAKER_{i % 2:02d}") for i, seg in enumerate(segments)]
