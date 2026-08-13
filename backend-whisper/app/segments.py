from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence


@dataclass(frozen=True)
class Segment:
    """An immutable transcript cue with a time range and text."""

    start: float
    end: float
    text: str
    # Diarized speaker label (e.g. "SPEAKER_00"); None when not diarized. Must be
    # carried through merge/split so diarization isn't silently lost when subtitle
    # quality post-processing runs.
    speaker: str | None = None

    @property
    def duration(self) -> float:
        return self.end - self.start


# Conservative defaults for merge heuristics. A segment is considered "short"
# (and a candidate for merging) when it is both very brief in time and in length.
DEFAULT_MERGE_MAX_DURATION = 1.5
DEFAULT_MERGE_MAX_CHARS = 12


def _to_segment(item: object) -> Segment:
    """Normalize a whisper segment (or any start/end/text object) to a Segment."""
    return Segment(
        start=float(getattr(item, "start")),
        end=float(getattr(item, "end")),
        text=str(getattr(item, "text")),
        speaker=getattr(item, "speaker", None),
    )


def normalize_segments(segments: Iterable[object]) -> list[Segment]:
    return [_to_segment(item) for item in segments]


def _is_short(segment: Segment, max_duration: float, max_chars: int) -> bool:
    return segment.duration < max_duration and len(segment.text.strip()) <= max_chars


def merge_short_segments(
    segments: Sequence[Segment],
    max_duration: float = DEFAULT_MERGE_MAX_DURATION,
    max_chars: int = DEFAULT_MERGE_MAX_CHARS,
) -> list[Segment]:
    """Merge adjacent very-short segments into a neighbour.

    A short segment (brief in both time and character length) is folded into the
    *following* segment when one exists, otherwise into the *previous* one. This
    avoids rapid one-word flickers. The merge concatenates text and extends the
    combined time range. The pass is conservative: only segments that satisfy
    ``_is_short`` are merged, and merging never drops or reorders content.
    """
    if not segments:
        return []

    result: list[Segment] = []
    # Carry holds a pending short segment that must be prepended to the next one.
    carry: Segment | None = None

    for segment in segments:
        if carry is not None:
            segment = _join(carry, segment)
            carry = None

        if _is_short(segment, max_duration, max_chars):
            # Defer to the following segment; if none follows, fold into previous.
            carry = segment
            continue

        result.append(segment)

    if carry is not None:
        if result:
            result[-1] = _join(result[-1], carry)
        else:
            # Every segment was short; emit the accumulated carry as-is.
            result.append(carry)

    return result


def _join(first: Segment, second: Segment) -> Segment:
    first_text = first.text.strip()
    second_text = second.text.strip()
    if first_text and second_text:
        text = f"{first_text} {second_text}"
    else:
        text = first_text or second_text
    return Segment(start=min(first.start, second.start), end=max(first.end, second.end), text=text, speaker=first.speaker or second.speaker)


def split_long_segments(segments: Sequence[Segment], max_duration: float | None) -> list[Segment]:
    """Split any segment longer than ``max_duration`` into evenly-timed cues.

    The time range is divided into equal slices and the words are distributed
    across those slices proportionally (at word boundaries). When ``max_duration``
    is falsy (None or <= 0) the input is returned unchanged.
    """
    if not max_duration or max_duration <= 0:
        return list(segments)

    result: list[Segment] = []
    for segment in segments:
        if segment.duration <= max_duration:
            result.append(segment)
            continue
        result.extend(_split_one(segment, max_duration))
    return result


def _split_one(segment: Segment, max_duration: float) -> list[Segment]:
    import math

    words = segment.text.strip().split()
    # Number of chunks needed so each is <= max_duration.
    chunks = max(1, math.ceil(segment.duration / max_duration))
    chunks = min(chunks, len(words)) if words else 1
    if chunks <= 1:
        return [segment]

    total = segment.duration
    slice_dur = total / chunks
    pieces: list[Segment] = []
    for index in range(chunks):
        start = segment.start + slice_dur * index
        end = segment.end if index == chunks - 1 else segment.start + slice_dur * (index + 1)
        # Distribute words proportionally across chunks.
        word_start = round(len(words) * index / chunks)
        word_end = round(len(words) * (index + 1) / chunks)
        if index == chunks - 1:
            word_end = len(words)
        chunk_words = words[word_start:word_end]
        pieces.append(Segment(start=start, end=end, text=" ".join(chunk_words), speaker=segment.speaker))
    return pieces


def postprocess_segments(
    segments: Iterable[object],
    *,
    merge_short: bool = False,
    max_subtitle_duration: float | None = None,
) -> list[Segment]:
    """Apply the post-processing pipeline: merge first, then split-by-duration.

    Line-wrapping (``max_line_length``) is applied later by the formatters, so it
    is intentionally not handled here. When neither merge nor split is requested,
    the segments are returned normalized but otherwise untouched, preserving
    byte-identical output relative to the previous behaviour.
    """
    normalized = normalize_segments(segments)
    if merge_short:
        normalized = merge_short_segments(normalized)
    if max_subtitle_duration:
        normalized = split_long_segments(normalized, max_subtitle_duration)
    return normalized
