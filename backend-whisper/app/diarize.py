from __future__ import annotations

import os
import threading
from types import SimpleNamespace
from typing import Any

from .gpu import cuda_device_count

# Gated pyannote pipeline (requires HF token + accepted license).
DIARIZATION_MODEL = "pyannote/speaker-diarization-3.1"

# One pipeline per torch device, loaded once (mirrors model_loader's cache).
_PIPELINE_CACHE: dict[str, Any] = {}
_CACHE_LOCK = threading.Lock()


class DiarizationUnavailableError(RuntimeError):
    """pyannote.audio is not installed in this backend."""


class DiarizationTokenMissingError(RuntimeError):
    """No Hugging Face token configured (or it lacks access) for the gated model."""


def _hf_token() -> str:
    return (os.environ.get("SUBSMELT_HF_TOKEN") or os.environ.get("HF_TOKEN") or "").strip()


def diarize_available() -> bool:
    """True when diarization can actually run: pyannote importable AND a token set.

    Used to advertise capabilities.speakerDiarization honestly so the frontend
    only offers the toggle when the backend can fulfil it.
    """
    if not _hf_token():
        return False
    try:
        import pyannote.audio  # type: ignore  # noqa: F401
    except Exception:  # noqa: BLE001 - any import failure means unavailable
        return False
    return True


def _resolve_torch_device(device: str) -> str:
    want = (device or "cpu").strip().lower()
    if want == "cuda" and cuda_device_count() > 0:
        return "cuda"
    return "cpu"


def _get_pipeline(device: str) -> Any:
    token = _hf_token()
    if not token:
        raise DiarizationTokenMissingError(
            "Speaker diarization needs a Hugging Face token; set SUBSMELT_HF_TOKEN "
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
            from pyannote.audio import Pipeline  # type: ignore
            import torch  # type: ignore
        except Exception as exc:  # noqa: BLE001 - re-raise as a typed/clear error
            raise DiarizationUnavailableError(
                "pyannote.audio is not installed in this backend"
            ) from exc
        pipeline = Pipeline.from_pretrained(DIARIZATION_MODEL, use_auth_token=token)
        if pipeline is None:
            # from_pretrained returns None when the token cannot access the gated repo.
            raise DiarizationTokenMissingError(
                "Could not load the diarization pipeline; the HF token may lack access "
                "— accept the pyannote/speaker-diarization-3.1 license and retry"
            )
        pipeline.to(torch.device(torch_device))
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


def assign_speakers(
    segments: list,
    audio_path: Any,
    device: str,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
) -> list:
    """Return new segments tagged with a ``speaker`` by max time-overlap.

    Runs the pyannote pipeline over the full audio (a post-pass), then labels
    each whisper segment with the diarized speaker it overlaps most.
    """
    pipeline = _get_pipeline(device)
    kwargs: dict[str, int] = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers
    annotation = pipeline(str(audio_path), **kwargs)
    turns = _turns_from_annotation(annotation)
    return [_copy_segment(seg, _label_for(
        float(getattr(seg, "start", 0.0) or 0.0),
        float(getattr(seg, "end", 0.0) or 0.0),
        turns,
    )) for seg in segments]


def fake_assign_speakers(segments: list) -> list:
    """Test double: alternate SPEAKER_00/SPEAKER_01 without pyannote/torch."""
    return [_copy_segment(seg, f"SPEAKER_{i % 2:02d}") for i, seg in enumerate(segments)]
