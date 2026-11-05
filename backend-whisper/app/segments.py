from __future__ import annotations

import math
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from types import SimpleNamespace

from .word_timing import CLAUSE_END, MIN_CUE_S, SENTENCE_END, Word, word_runs


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
    words: tuple[Word, ...] = ()

    @property
    def duration(self) -> float:
        return self.end - self.start


# Conservative defaults for merge heuristics. A segment is considered "short"
# (and a candidate for merging) when it is both very brief in time and in length.
DEFAULT_MERGE_MAX_DURATION = 1.5
DEFAULT_MERGE_MAX_CHARS = 12
# A short cue further than this from its neighbour is its own utterance (a
# greeting before a long pause); folding it across the gap would show it with
# speech from much later. Wide enough to still absorb a lead-in before a short
# pause at the start of a sentence.
DEFAULT_MERGE_MAX_GAP = 3.0


def has_wide_chars(text: str) -> bool:
    """True when ``text`` holds East Asian wide/fullwidth characters (CJK), the
    scripts that carry no spaces and so must be measured per character."""
    return any(unicodedata.east_asian_width(ch) in ("W", "F") for ch in text)


def _attaches(previous: str, text: str) -> bool:
    part = text.strip()
    if all(char in SENTENCE_END + CLAUSE_END or unicodedata.category(char) in ("Pe", "Pf") for char in part):
        return True
    previous = previous.strip()
    if all(unicodedata.category(char) in ("Ps", "Pi") for char in previous):
        return True
    # A decoder can provide separate timing tokens for each part of a decimal.
    return (
        not text[0].isspace()
        and len(previous) > 1
        and previous[-1] == "."
        and previous[-2].isdecimal()
        and part[0].isdecimal()
    )


def _aligned_words(item: object, text: str, start: float, end: float) -> tuple[Word, ...]:
    """Keep the source spacing and punctuation. An incomplete alignment falls back as a whole cue."""
    aligned: list[Word] = []
    cursor = 0
    last_start = -math.inf
    for word in getattr(item, "words", None) or ():
        raw_text = getattr(word, "word", getattr(word, "text", ""))
        if not isinstance(raw_text, str):
            return ()
        part = raw_text.strip()
        if not part:
            continue
        content_start = cursor
        while content_start < len(text) and text[content_start].isspace():
            content_start += 1
        if not text.startswith(part, content_start):
            return ()
        next_cursor = content_start + len(part)
        fragment = text[cursor:next_cursor]
        cursor = next_cursor
        try:
            word_start, word_end = float(word.start), float(word.end)
        except (AttributeError, TypeError, ValueError):
            return ()
        if not (math.isfinite(word_start) and math.isfinite(word_end) and last_start <= word_start <= word_end):
            return ()
        last_start = word_start
        word_start = min(end, max(start, word_start))
        word_end = min(end, max(start, word_end))
        if aligned:
            previous = aligned[-1]
            if (
                word_end <= max(word_start, previous.end)
                or previous.end <= previous.start
                or _attaches(previous.text, fragment)
            ):
                aligned[-1] = Word(previous.text + fragment, previous.start, max(previous.end, word_end))
                continue
            word_start = max(previous.end, word_start)
        aligned.append(Word(fragment, word_start, word_end))

    if text[cursor:].strip() or not aligned or aligned[-1].end <= aligned[0].start:
        return ()
    return tuple(aligned)


def _to_segment(item: object, *, end: float | None = None) -> Segment:
    """Normalize a whisper segment (or any start/end/text object) to a Segment."""
    if isinstance(item, Segment) and end is None:
        return item
    start = float(item.start)
    end = float(item.end) if end is None else end
    text = str(item.text)
    return Segment(start, end, text, getattr(item, "speaker", None), _aligned_words(item, text, start, end))


def normalize_segments(segments: Iterable[object]) -> list[Segment]:
    return [_to_segment(item) for item in segments]


def snap_start_to_words(item: object) -> object:
    """Move a cue's start to its first word when the model stretched it back
    over lead-in silence.

    Faster-whisper routinely pins the opening segment to 0:00 while the first
    word is spoken seconds later; the per-word timestamps are measurements of
    where speech actually begins, the segment start is an estimate. Words are
    preserved (the diarization pass copies them through); segments without
    word timestamps, and cues whose first word does not begin after the
    segment's own start, are returned unchanged.
    """
    words = getattr(item, "words", None) or []
    try:
        first = next(float(word.start) for word in words if getattr(word, "start", None) is not None)
    except (StopIteration, TypeError, ValueError):
        return item
    start = float(getattr(item, "start", 0.0) or 0.0)
    end = float(getattr(item, "end", 0.0) or 0.0)
    # Only snap forward inside the cue. Word clocks can drift to or past their
    # own segment's end; snapping there would leave a zero-length cue players
    # never show, or an inverted one, so the segment keeps its timing.
    if not start < first < end:
        return item
    return SimpleNamespace(
        start=first,
        end=end,
        text=str(getattr(item, "text", "") or ""),
        words=words,
        speaker=getattr(item, "speaker", None),
    )


def _is_short(segment: Segment, max_duration: float, max_chars: int) -> bool:
    return segment.duration < max_duration and len(segment.text.strip()) <= max_chars


def merge_short_segments(
    segments: Sequence[Segment],
    max_duration: float = DEFAULT_MERGE_MAX_DURATION,
    max_chars: int = DEFAULT_MERGE_MAX_CHARS,
    max_gap: float = DEFAULT_MERGE_MAX_GAP,
    *,
    split_duration: float | None = None,
) -> list[Segment]:
    """Merge adjacent very-short segments into a neighbour.

    A short segment (brief in both time and character length) is folded into the
    *following* segment when one starts within ``max_gap``, otherwise into the
    *previous* one when that ended within ``max_gap``, otherwise kept as is. This
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
    # Where the run of short segments folded into ``carry`` began. ``carry`` sits
    # on the newest segment's clock, so its own duration resets at every forward
    # merge; the "still short" test must span the whole run, or a run of short
    # cues keeps folding until the char cap and shows only in its final second.
    run_start = 0.0

    for segment in segments:
        if carry is not None:
            if _can_merge(carry, segment, max_gap, split_duration):
                segment = _join_following(carry, segment)
            else:
                _emit_carry(result, carry, max_gap, split_duration)
                run_start = segment.start
            carry = None
        else:
            run_start = segment.start

        if _is_short(segment, max_duration, max_chars) and segment.end - run_start < max_duration:
            # Defer to the following segment; if none follows, fold into previous.
            carry = segment
            continue

        result.append(segment)

    if carry is not None:
        _emit_carry(result, carry, max_gap, split_duration)

    return result


def _emit_carry(result: list[Segment], carry: Segment, max_gap: float, split_duration: float | None) -> None:
    """A short cue that cannot join what follows: fold it into the previous cue
    when that one is near, otherwise keep it as is."""
    if result and _can_merge(result[-1], carry, max_gap, split_duration):
        result[-1] = _join(result[-1], carry)
    else:
        result.append(carry)


def _can_merge(first: Segment, second: Segment, max_gap: float, split_duration: float | None) -> bool:
    # If a merge would subsequently be split, keep each measured word timeline
    # on its source cue. Forward merges move the original start to the next cue.
    if split_duration and split_duration > 0:
        duration = max(first.end, second.end) - min(first.start, second.start)
        if duration > split_duration:
            return False
    return _same_speaker(first, second) and second.start - first.end <= max_gap


def _same_speaker(first: Segment, second: Segment) -> bool:
    """Merging across two different diarized speakers would misattribute text."""
    return first.speaker is None or second.speaker is None or first.speaker == second.speaker


def _join(first: Segment, second: Segment) -> Segment:
    first_text = first.text.strip()
    second_text = second.text.strip()
    text = f"{first_text} {second_text}" if first_text and second_text else first_text or second_text
    return Segment(
        start=min(first.start, second.start),
        end=max(first.end, second.end),
        text=text,
        speaker=first.speaker or second.speaker,
    )


def _join_following(carry: Segment, following: Segment) -> Segment:
    """Concatenate a carried lead-in onto ``following``, on ``following``'s clock.

    Same content rules as ``_join``, but the merged cue starts when the
    following segment starts (see ``merge_short_segments`` for why).
    """
    joined = _join(carry, following)
    return Segment(start=following.start, end=joined.end, text=joined.text, speaker=joined.speaker)


def clamp_to_duration(
    segments: Sequence[Segment],
    duration: float | None,
) -> list[Segment]:
    """Drop cues that begin at or after the audio ends; pull late ends back.

    Speech models invent tail text on trailing silence, music or credits, and
    their timestamps are model estimates that can run past the file. The decoded
    audio duration is the authority: nothing spoken exists after it, so a cue
    that *starts* there is hallucination and is dropped, and one that merely
    *overruns* is truncated. An unknown or non-positive duration leaves the
    segments untouched.
    """
    if not duration or duration <= 0:
        return list(segments)

    clamped: list[Segment] = []
    for segment in segments:
        if segment.start >= duration:
            continue
        if segment.end > duration:
            segment = _to_segment(segment, end=duration)
        clamped.append(segment)
    return clamped


def split_long_segments(
    segments: Sequence[Segment], max_duration: float | None, *, audio_duration: float | None = None
) -> list[Segment]:
    """Split overlong cues at measured word boundaries when available.

    For a cue without usable word timing, distribute its text across equal time slices.
    """
    if not max_duration or max_duration <= 0:
        return list(segments)

    result: list[Segment] = []
    short_cues: list[tuple[int, float]] = []
    min_duration = min(MIN_CUE_S, max_duration)
    for segment in segments:
        if segment.duration <= max_duration:
            result.append(segment)
            continue
        if segment.words:
            for run in word_runs(segment.words, lambda run: run[-1].end - run[0].start > max_duration):
                cue = Segment(run[0].start, run[-1].end, "".join(word.text for word in run).strip(), segment.speaker)
                if cue.duration < min_duration:
                    short_cues.append((len(result), segment.end))
                result.append(cue)
        else:
            result.extend(_split_one(segment, max_duration))

    # A duration cut can leave a single very short word at the end of a cue.
    # Hold it into available silence without moving its measured onset.
    audio_end = audio_duration if audio_duration and audio_duration > 0 else math.inf
    for index, source_end in short_cues:
        cue = result[index]
        if index + 1 < len(result):
            limit = result[index + 1].start
        else:
            limit = source_end if audio_end == math.inf else audio_end
        end = min(cue.start + min_duration, limit, audio_end)
        if end > cue.end:
            result[index] = replace(cue, end=end)
    return result


def _split_one(segment: Segment, max_duration: float) -> list[Segment]:
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
        pieces.append(
            Segment(start=start, end=end, text=joiner.join(units[unit_start:unit_end]), speaker=segment.speaker)
        )
    return pieces


def postprocess_segments(
    segments: Iterable[object],
    *,
    merge_short: bool = False,
    max_subtitle_duration: float | None = None,
    audio_duration: float | None = None,
) -> list[Segment]:
    """Apply the post-processing pipeline: merge first, then split-by-duration.

    Line-wrapping (``max_line_length``) is applied later by the formatters, so it
    is intentionally not handled here. When neither merge nor split is requested,
    the segments are returned normalized but otherwise untouched, preserving
    byte-identical output relative to the previous behaviour.
    """
    normalized = normalize_segments(segments)
    if merge_short:
        split_duration = max_subtitle_duration if any(segment.words for segment in normalized) else None
        normalized = merge_short_segments(normalized, split_duration=split_duration)
    if max_subtitle_duration:
        normalized = split_long_segments(normalized, max_subtitle_duration, audio_duration=audio_duration)
    return normalized
