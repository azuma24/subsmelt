"""Tests for the subtitle writer."""

from pathlib import Path

import pytest

from subsmelt_whisper.pipeline.whisper_runner import Segment
from subsmelt_whisper.pipeline.writer import (
    atomic_write,
    serialise,
    to_srt,
    to_txt,
    to_vtt,
)


@pytest.fixture
def segments():
    return [
        Segment(start=0.0, end=1.5, text="Hello world."),
        Segment(start=1.5, end=3.250, text="How are you?"),
    ]


def test_srt_formatting(segments):
    srt = to_srt(segments)
    assert "1\n00:00:00,000 --> 00:00:01,500\nHello world." in srt
    assert "2\n00:00:01,500 --> 00:00:03,250\nHow are you?" in srt


def test_vtt_formatting(segments):
    vtt = to_vtt(segments)
    assert vtt.startswith("WEBVTT")
    assert "00:00:00.000 --> 00:00:01.500" in vtt
    assert "00:00:01.500 --> 00:00:03.250" in vtt


def test_txt_formatting(segments):
    txt = to_txt(segments)
    assert txt.strip() == "Hello world.\nHow are you?"


def test_serialise_dispatch(segments):
    assert serialise(segments, "srt") == to_srt(segments)
    assert serialise(segments, "vtt") == to_vtt(segments)
    assert serialise(segments, "txt") == to_txt(segments)
    with pytest.raises(ValueError):
        serialise(segments, "xml")


def test_atomic_write_creates_file(tmp_path: Path, segments):
    target = tmp_path / "sub.srt"
    atomic_write(target, to_srt(segments))
    assert target.read_text(encoding="utf-8").startswith("1\n")


def test_millisecond_rounding_does_not_exceed_999():
    # 0.9999 -> 1000ms would otherwise render as ..000 with whole bumped by 1.
    from subsmelt_whisper.pipeline.writer import _fmt_ts

    assert _fmt_ts(0.9999, True) == "00:00:01,000"
