from __future__ import annotations

from pathlib import Path
from typing import Iterable, Protocol


class SegmentLike(Protocol):
    start: float
    end: float
    text: str


def _timestamp(seconds: float, sep: str = ",") -> str:
    ms_total = int(round(seconds * 1000))
    hours, rem = divmod(ms_total, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{ms:03d}"


def write_srt(segments: Iterable[SegmentLike], output_path: Path) -> int:
    lines: list[str] = []
    count = 0
    for count, segment in enumerate(segments, start=1):
        lines.append(str(count))
        lines.append(f"{_timestamp(segment.start)} --> {_timestamp(segment.end)}")
        lines.append(segment.text.strip())
        lines.append("")
    output_path.write_text("\n".join(lines), encoding="utf-8")
    return count


def write_vtt(segments: Iterable[SegmentLike], output_path: Path) -> int:
    lines = ["WEBVTT", ""]
    count = 0
    for count, segment in enumerate(segments, start=1):
        lines.append(f"{_timestamp(segment.start, '.')} --> {_timestamp(segment.end, '.')}")
        lines.append(segment.text.strip())
        lines.append("")
    output_path.write_text("\n".join(lines), encoding="utf-8")
    return count


def write_txt(segments: Iterable[SegmentLike], output_path: Path) -> int:
    texts: list[str] = []
    count = 0
    for count, segment in enumerate(segments, start=1):
        text = segment.text.strip()
        if text:
            texts.append(text)
    output_path.write_text("\n".join(texts) + ("\n" if texts else ""), encoding="utf-8")
    return count


def write_transcript(segments: Iterable[SegmentLike], output_path: Path, output_format: str) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_format == "vtt":
        return write_vtt(segments, output_path)
    if output_format == "txt":
        return write_txt(segments, output_path)
    return write_srt(segments, output_path)
