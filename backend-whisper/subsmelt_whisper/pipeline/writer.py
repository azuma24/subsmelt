"""Serialise whisper segments to SRT / WebVTT / plain text."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Iterable

from .whisper_runner import Segment

SUPPORTED_FORMATS = {"srt", "vtt", "txt"}


def _fmt_ts(seconds: float, comma: bool) -> str:
    if seconds < 0:
        seconds = 0.0
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds - (hours * 3600) - (minutes * 60)
    whole = int(secs)
    millis = int(round((secs - whole) * 1000))
    if millis == 1000:
        whole += 1
        millis = 0
    sep = "," if comma else "."
    return f"{hours:02d}:{minutes:02d}:{whole:02d}{sep}{millis:03d}"


def to_srt(segments: Iterable[Segment]) -> str:
    out: list[str] = []
    for i, seg in enumerate(segments, start=1):
        out.append(str(i))
        out.append(f"{_fmt_ts(seg.start, True)} --> {_fmt_ts(seg.end, True)}")
        out.append(seg.text)
        out.append("")
    return "\n".join(out).strip() + "\n"


def to_vtt(segments: Iterable[Segment]) -> str:
    out: list[str] = ["WEBVTT", ""]
    for seg in segments:
        out.append(f"{_fmt_ts(seg.start, False)} --> {_fmt_ts(seg.end, False)}")
        out.append(seg.text)
        out.append("")
    return "\n".join(out).strip() + "\n"


def to_txt(segments: Iterable[Segment]) -> str:
    return "\n".join(seg.text for seg in segments).strip() + "\n"


def serialise(segments: Iterable[Segment], fmt: str) -> str:
    fmt = fmt.lower()
    if fmt == "srt":
        return to_srt(segments)
    if fmt == "vtt":
        return to_vtt(segments)
    if fmt == "txt":
        return to_txt(segments)
    raise ValueError(f"Unsupported subtitle format: {fmt}")


def atomic_write(path: Path, content: str) -> Path:
    """Write via a temp file + rename, chmod 0o666 so subsmelt can later overwrite."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        try:
            os.chmod(tmp, 0o666)
        except OSError:
            pass
        tmp.replace(path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return path
