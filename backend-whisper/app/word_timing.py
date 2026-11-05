"""Group measured words into subtitle cues."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass

SENTENCE_END = ".!?。！？…"
CLAUSE_END = ",;:、，；："
MAX_GAP_S = 0.6
MIN_CUE_S = 0.5


@dataclass(frozen=True)
class Word:
    text: str
    start: float
    end: float


def _split_run(run: list[Word]) -> tuple[list[Word], list[Word]]:
    """Cut after the last clause punctuation in the run's second half."""
    count = len(run)
    for index in range(count - 2, count // 2 - 1, -1):
        if run[index].text and run[index].text[-1] in CLAUSE_END:
            return run[: index + 1], run[index + 1 :]
    return run, []


def word_runs(words: Sequence[Word], exceeds: Callable[[Sequence[Word]], bool]) -> Iterator[list[Word]]:
    run: list[Word] = []
    for word in words:
        if not word.text.strip():
            continue
        if run and word.start - run[-1].end > MAX_GAP_S:
            yield run
            run = []
        while run and exceeds([*run, word]):
            head, run = _split_run(run)
            yield head
        run.append(word)
        if word.text[-1] in SENTENCE_END:
            yield run
            run = []
    if run:
        yield run
