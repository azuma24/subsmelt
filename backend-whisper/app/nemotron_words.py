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

SENTENCE_END = ".!?。！？…"
CLAUSE_END = ",;:、，；："
MAX_GAP_S = 0.6
DEFAULT_MAX_DURATION_S = 6.0
DEFAULT_MAX_LINE_SPACED = 42
DEFAULT_MAX_LINE_WIDE = 16
LINES_PER_CUE = 2
# A lone word can arrive with one timestamp for start and end; a zero-length
# cue is never shown, so it is given this long on screen.
MIN_CUE_S = 0.5


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
