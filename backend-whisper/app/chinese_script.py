"""Convert Chinese transcripts to the script the user reads.

Speech models emit whichever script their training data favoured (Whisper
mostly Simplified, sometimes a mix), while the app lets the user prefer
Traditional (Taiwan) or Simplified. OpenCC does the conversion:
``s2twp`` maps Simplified to Traditional with Taiwan phrasing (软件 -> 軟體),
leaving text that is already Traditional unchanged, so mixed output comes out
uniform; ``t2s`` maps Traditional to Simplified.
"""

from __future__ import annotations

from collections.abc import Iterable
from functools import cache
from typing import Literal

from .nemotron_languages import normalize_language
from .segments import Segment

ChineseScript = Literal["zh-TW", "zh-CN"]

_OPENCC_CONVERSIONS: dict[str, str] = {"zh-TW": "s2twp", "zh-CN": "t2s"}


def is_chinese(language: str | None) -> bool:
    """True for ``zh``, its regional forms and the ISO-639-2 ``chi``/``zho``."""
    return normalize_language(language or "").startswith("zh")


@cache
def _converter(conversion: str):
    # Imported here: loading the dictionaries costs a moment, and only
    # Chinese transcripts need them.
    from opencc import OpenCC

    return OpenCC(conversion)


def convert_segments(segments: Iterable[object], script: ChineseScript) -> list[Segment]:
    """Every cue's text in ``script``; timing and speaker are kept."""
    converter = _converter(_OPENCC_CONVERSIONS[script])
    return [
        Segment(
            start=float(segment.start),
            end=float(segment.end),
            text=converter.convert(str(getattr(segment, "text", "") or "")),
            speaker=getattr(segment, "speaker", None),
        )
        for segment in segments
    ]
