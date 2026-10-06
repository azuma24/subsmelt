"""Subtitle cues from Nemotron's punctuated, word-timed output.

A cue ends at sentence punctuation, at a pause, or when the next word would
push it past the duration or length limit. Length is measured in characters,
which is what matters for CJK text that carries no spaces.
"""

from __future__ import annotations

import itertools
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

from .schemas import SubtitleQualityOptions
from .segments import Segment, has_wide_chars

SENTENCE_END = ".!?。！？…"
CLAUSE_END = ",;:、，；："
MAX_GAP_S = 0.6
DEFAULT_MAX_DURATION_S = 6.0
DEFAULT_MAX_LINE_SPACED = 42
DEFAULT_MAX_LINE_WIDE = 16
LINES_PER_CUE = 2


@dataclass(frozen=True)
class Word:
    text: str
    start: float
    end: float


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


def join_words(words: Sequence[Word]) -> str:
    """Space-separated, except between two wide (CJK) characters."""
    out = words[0].text
    for previous, current in itertools.pairwise(words):
        glued = previous.text and current.text and _wide(previous.text[-1]) and _wide(current.text[0])
        out += current.text if glued else " " + current.text
    return out


def _exceeds(run: Sequence[Word], limits: _Limits) -> bool:
    text = join_words(run)
    return run[-1].end - run[0].start > limits.max_duration or len(text) > limits.max_chars(text)


def _split_run(run: list[Word]) -> tuple[list[Word], list[Word]]:
    """Cut after the last clause punctuation in the run's second half, else
    after the last word."""
    count = len(run)
    for index in range(count - 2, count // 2 - 1, -1):
        if run[index].text and run[index].text[-1] in CLAUSE_END:
            return run[: index + 1], run[index + 1 :]
    return run, []


def _segment(run: Sequence[Word]) -> Segment:
    return Segment(start=run[0].start, end=run[-1].end, text=join_words(run).strip())


def _monotonic(segments: list[Segment]) -> list[Segment]:
    """Word timings can overlap by a few ms at cue boundaries; keep cues in order."""
    out: list[Segment] = []
    for segment in segments:
        if out and segment.start < out[-1].end:
            segment = Segment(
                start=out[-1].end, end=max(segment.end, out[-1].end), text=segment.text, speaker=segment.speaker
            )
        out.append(segment)
    return out


def words_to_segments(words: Sequence[Word], quality: SubtitleQualityOptions | None) -> list[Segment]:
    limits = _limits(quality)
    segments: list[Segment] = []
    run: list[Word] = []
    for word in words:
        if not word.text.strip():
            continue
        if run and word.start - run[-1].end > MAX_GAP_S:
            segments.append(_segment(run))
            run = []
        while run and _exceeds([*run, word], limits):
            head, run = _split_run(run)
            segments.append(_segment(head))
        run.append(word)
        if word.text[-1] in SENTENCE_END:
            segments.append(_segment(run))
            run = []
    if run:
        segments.append(_segment(run))
    return _monotonic(segments)
