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


def _speaker(segment: object) -> str:
    """The segment's diarized speaker label, or '' when not diarized."""
    return str(getattr(segment, "speaker", "") or "")


def _with_speaker(segment: object) -> str:
    """Segment text, prefixed with ``[SPEAKER_x] `` when a speaker is assigned."""
    spk = _speaker(segment)
    text = getattr(segment, "text", "") or ""
    return f"[{spk}] {text}" if spk else text


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
        lines.append(_wrap_text(_with_speaker(segment), max_line_length))
        lines.append("")
    output_path.write_text("\n".join(lines), encoding="utf-8")
    return count


def write_vtt(segments: Iterable[SegmentLike], output_path: Path, max_line_length: int | None = None) -> int:
    lines = ["WEBVTT", ""]
    count = 0
    for count, segment in enumerate(segments, start=1):
        lines.append(f"{_timestamp(segment.start, '.')} --> {_timestamp(segment.end, '.')}")
        lines.append(_wrap_text(_with_speaker(segment), max_line_length))
        lines.append("")
    output_path.write_text("\n".join(lines), encoding="utf-8")
    return count


def write_txt(segments: Iterable[SegmentLike], output_path: Path) -> int:
    texts: list[str] = []
    count = 0
    for count, segment in enumerate(segments, start=1):
        text = _with_speaker(segment).strip()
        if text:
            texts.append(text)
    output_path.write_text("\n".join(texts) + ("\n" if texts else ""), encoding="utf-8")
    return count


def _ass_timestamp(seconds: float) -> str:
    """ASS time: H:MM:SS.cc (centiseconds, single-digit hours)."""
    cs_total = int(round(seconds * 100))
    hours, rem = divmod(cs_total, 360_000)
    minutes, rem = divmod(rem, 6_000)
    secs, cs = divmod(rem, 100)
    return f"{hours:d}:{minutes:02d}:{secs:02d}.{cs:02d}"


_ASS_HEADER = """[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def write_ass(segments: Iterable[SegmentLike], output_path: Path, max_line_length: int | None = None) -> int:
    """Write Advanced SubStation Alpha (.ass). Line breaks use ASS's ``\\N``."""
    lines = [_ASS_HEADER]
    count = 0
    for count, segment in enumerate(segments, start=1):
        text = _wrap_text(segment.text, max_line_length).replace("\n", "\\N")
        # Speaker goes in the ASS Name/actor field (not the rendered text).
        name = _speaker(segment)
        lines.append(
            f"Dialogue: 0,{_ass_timestamp(segment.start)},{_ass_timestamp(segment.end)},Default,{name},0,0,0,,{text}"
        )
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
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
    if output_format == "ass":
        return write_ass(segments, output_path, max_line_length=max_line_length)
    return write_srt(segments, output_path, max_line_length=max_line_length)
