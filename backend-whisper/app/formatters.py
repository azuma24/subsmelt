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


def _wrap_text(text: str, max_line_length: int | None = None) -> str:
    stripped = text.strip()
    if not stripped or not max_line_length or max_line_length < 1:
        return stripped

    words = stripped.split()
    if not words:
        return stripped

    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if len(candidate) <= max_line_length:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return "\n".join(lines)


def write_srt(segments: Iterable[SegmentLike], output_path: Path, max_line_length: int | None = None) -> int:
    lines: list[str] = []
    count = 0
    for count, segment in enumerate(segments, start=1):
        lines.append(str(count))
        lines.append(f"{_timestamp(segment.start)} --> {_timestamp(segment.end)}")
        lines.append(_wrap_text(segment.text, max_line_length))
        lines.append("")
    output_path.write_text("\n".join(lines), encoding="utf-8")
    return count


def write_vtt(segments: Iterable[SegmentLike], output_path: Path, max_line_length: int | None = None) -> int:
    lines = ["WEBVTT", ""]
    count = 0
    for count, segment in enumerate(segments, start=1):
        lines.append(f"{_timestamp(segment.start, '.')} --> {_timestamp(segment.end, '.')}")
        lines.append(_wrap_text(segment.text, max_line_length))
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


def write_transcript(
    segments: Iterable[SegmentLike],
    output_path: Path,
    output_format: str,
    max_line_length: int | None = None,
) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_format == "vtt":
        return write_vtt(segments, output_path, max_line_length=max_line_length)
    if output_format == "txt":
        return write_txt(segments, output_path)
    return write_srt(segments, output_path, max_line_length=max_line_length)
