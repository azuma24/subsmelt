"""Subtitle cues from Nemotron's punctuated, word-timed output.

A cue ends at sentence punctuation, at a pause, or when the next word would
push it past the duration or length limit. Length is measured in characters,
which is what matters for CJK text that carries no spaces.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

from .schemas import SubtitleQualityOptions
from .segments import Segment, has_wide_chars
from .word_timing import MIN_CUE_S, word_runs
from .word_timing import Word as Word

DEFAULT_MAX_DURATION_S = 6.0
DEFAULT_MAX_LINE_SPACED = 42
DEFAULT_MAX_LINE_WIDE = 16
LINES_PER_CUE = 2


@dataclass(frozen=True)
class _Limits:
    max_duration: float
    max_line: int | None

    def max_chars(self, text: str) -> int:
        per_line = self.max_line or (DEFAULT_MAX_LINE_WIDE if has_wide_chars(text) else DEFAULT_MAX_LINE_SPACED)
        return LINES_PER_CUE * per_line


def _limits(quality: SubtitleQualityOptions | None) -> _Limits:
    max_duration = (
        quality.max_subtitle_duration if quality and quality.max_subtitle_duration else DEFAULT_MAX_DURATION_S
    )
    return _Limits(max_duration=max_duration, max_line=quality.max_line_length if quality else None)


def _wide(char: str) -> bool:
    return unicodedata.east_asian_width(char) in ("W", "F")


def _glue(previous: str, current: str) -> str:
    """``previous`` then ``current``, space-separated except between two wide
    (CJK) characters."""
    glued = previous and current and _wide(previous[-1]) and _wide(current[0])
    return previous + current if glued else f"{previous} {current}"


def join_words(words: Sequence[Word]) -> str:
    out = words[0].text
    for word in words[1:]:
        out = _glue(out, word.text)
    return out


def _exceeds(run: Sequence[Word], limits: _Limits) -> bool:
    text = join_words(run)
    return run[-1].end - run[0].start > limits.max_duration or len(text) > limits.max_chars(text)


def _segment(run: Sequence[Word]) -> Segment:
    return Segment(start=run[0].start, end=run[-1].end, text=join_words(run).strip())


def _monotonic(segments: list[Segment]) -> list[Segment]:
    """Keep cues in order and never empty.

    Word timings can overlap by a few ms at cue boundaries, so a cue starts
    where the previous ended. A cue timed entirely inside the previous one
    (a filler word the model placed mid-sentence) joins its text instead of
    becoming a zero-length cue, and a cue with no duration is padded."""
    out: list[Segment] = []
    for segment in segments:
        if out and segment.start < out[-1].end:
            if segment.end <= out[-1].end:
                out[-1] = Segment(out[-1].start, out[-1].end, _glue(out[-1].text, segment.text), out[-1].speaker)
                continue
            segment = Segment(start=out[-1].end, end=segment.end, text=segment.text, speaker=segment.speaker)
        if segment.end <= segment.start:
            segment = Segment(segment.start, segment.start + MIN_CUE_S, segment.text, segment.speaker)
        out.append(segment)
    return out


def words_to_segments(words: Sequence[Word], quality: SubtitleQualityOptions | None) -> list[Segment]:
    limits = _limits(quality)
    return _monotonic([_segment(run) for run in word_runs(words, lambda run: _exceeds(run, limits))])
