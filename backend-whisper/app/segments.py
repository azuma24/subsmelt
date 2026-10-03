from __future__ import annotations

import unicodedata
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


def has_wide_chars(text: str) -> bool:
    """True when ``text`` holds East Asian wide/fullwidth characters (CJK), the
    scripts that carry no spaces and so must be measured per character."""
    return any(unicodedata.east_asian_width(ch) in ("W", "F") for ch in text)


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

    A forward merge keeps the *following* segment's start time. Taking the
    earliest start instead would pin the next sentence to the lead-in's clock:
    audio that opens with silence or music yields a tiny first segment at 0:00,
    and the merged cue then displays real dialogue seconds before it is spoken.
    The short lead-in's own words show a beat late instead — the lesser wrong.
    """
    if not segments:
        return []

    result: list[Segment] = []
    # Carry holds a pending short segment that must be prepended to the next one.
    carry: Segment | None = None

    for segment in segments:
        if carry is not None:
            if _same_speaker(carry, segment):
                segment = _join_following(carry, segment)
            else:
                result.append(carry)
            carry = None

        if _is_short(segment, max_duration, max_chars):
            # Defer to the following segment; if none follows, fold into previous.
            carry = segment
            continue

        result.append(segment)

    if carry is not None:
        if result and _same_speaker(result[-1], carry):
            result[-1] = _join(result[-1], carry)
        else:
            # Every segment was short (or the neighbour is another speaker);
            # emit the accumulated carry as-is.
            result.append(carry)

    return result


def _same_speaker(first: Segment, second: Segment) -> bool:
    """Merging across two different diarized speakers would misattribute text."""
    return first.speaker is None or second.speaker is None or first.speaker == second.speaker


def _join(first: Segment, second: Segment) -> Segment:
    first_text = first.text.strip()
    second_text = second.text.strip()
    if first_text and second_text:
        text = f"{first_text} {second_text}"
    else:
        text = first_text or second_text
    return Segment(start=min(first.start, second.start), end=max(first.end, second.end), text=text, speaker=first.speaker or second.speaker)


def _join_following(carry: Segment, following: Segment) -> Segment:
    """Concatenate a carried lead-in onto ``following``, on ``following``'s clock.

    Same content rules as ``_join``, but the merged cue starts when the
    following segment starts (see ``merge_short_segments`` for why).
    """
    joined = _join(carry, following)
    return Segment(start=following.start, end=joined.end, text=joined.text, speaker=joined.speaker)


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

    stripped = segment.text.strip()
    words = stripped.split()
    # Unspaced CJK text is one "word"; split it by character. A lone Latin word
    # (or a URL) stays whole, as before.
    if len(words) == 1 and has_wide_chars(stripped):
        units, joiner = list(stripped), ""
    else:
        units, joiner = words, " "
    # Number of chunks needed so each is <= max_duration.
    chunks = max(1, math.ceil(segment.duration / max_duration))
    chunks = min(chunks, len(units)) if units else 1
    if chunks <= 1:
        return [segment]

    total = segment.duration
    slice_dur = total / chunks
    pieces: list[Segment] = []
    for index in range(chunks):
        start = segment.start + slice_dur * index
        end = segment.end if index == chunks - 1 else segment.start + slice_dur * (index + 1)
        # Distribute units proportionally across chunks.
        unit_start = round(len(units) * index / chunks)
        unit_end = round(len(units) * (index + 1) / chunks)
        if index == chunks - 1:
            unit_end = len(units)
        pieces.append(Segment(start=start, end=end, text=joiner.join(units[unit_start:unit_end]), speaker=segment.speaker))
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
