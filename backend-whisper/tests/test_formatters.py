import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from app.formatters import _wrap_text, write_srt, write_transcript, write_txt, write_vtt


def _two_segments():
    return [
        SimpleNamespace(start=1.0, end=3.5, text="hello world"),
        SimpleNamespace(start=3.5, end=5.0, text="second line"),
    ]


class AssFormatterTests(unittest.TestCase):
    def _write(self, fmt: str, **kw) -> str:
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / f"o.{fmt}"
            count = write_transcript(_two_segments(), out, fmt, **kw)
            self.assertEqual(count, 2)
            return out.read_text(encoding="utf-8")

    def test_ass_has_headers_and_dialogue(self):
        txt = self._write("ass")
        self.assertIn("[Script Info]", txt)
        self.assertIn("[V4+ Styles]", txt)
        self.assertIn("[Events]", txt)
        self.assertIn("Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,hello world", txt)

    def test_ass_line_wrap_uses_ass_newline(self):
        txt = self._write("ass", max_line_length=5)
        dialogue = [ln for ln in txt.splitlines() if ln.startswith("Dialogue:")]
        self.assertTrue(any("\\N" in ln for ln in dialogue))

    def test_unknown_format_falls_back_to_srt(self):
        txt = self._write("xyz")
        self.assertIn("-->", txt)


class EmptyCueTests(unittest.TestCase):
    def _segments(self):
        return [
            SimpleNamespace(start=0.0, end=1.0, text="a"),
            SimpleNamespace(start=1.0, end=2.0, text="  "),
            SimpleNamespace(start=2.0, end=3.0, text="b"),
        ]

    def test_srt_skips_blank_cues_and_renumbers(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "o.srt"
            count = write_srt(self._segments(), out)
            self.assertEqual(count, 2)
            self.assertEqual(
                out.read_text(encoding="utf-8"),
                "1\n00:00:00,000 --> 00:00:01,000\na\n\n2\n00:00:02,000 --> 00:00:03,000\nb\n",
            )

    def test_vtt_skips_blank_cues(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "o.vtt"
            count = write_vtt(self._segments(), out)
            self.assertEqual(count, 2)
            self.assertEqual(
                out.read_text(encoding="utf-8"),
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na\n\n00:00:02.000 --> 00:00:03.000\nb\n",
            )

    def test_ass_and_txt_skip_blank_cues(self):
        with tempfile.TemporaryDirectory() as d:
            ass = Path(d) / "o.ass"
            self.assertEqual(write_transcript(self._segments(), ass, "ass"), 2)
            dialogue = [ln for ln in ass.read_text(encoding="utf-8").splitlines() if ln.startswith("Dialogue:")]
            self.assertEqual(len(dialogue), 2)
            txt = Path(d) / "o.txt"
            self.assertEqual(write_txt(self._segments(), txt), 2)
            self.assertEqual(txt.read_text(encoding="utf-8"), "a\nb\n")


class CjkWrapTests(unittest.TestCase):
    def test_unspaced_text_wraps_by_character_count(self):
        text = "これは日本語の長い字幕テキストで空白がありません"
        self.assertEqual(_wrap_text(text, 10), "これは日本語の長い字\n幕テキストで空白があ\nりません")

    def test_unspaced_text_prefers_breaking_after_sentence_punctuation(self):
        self.assertEqual(_wrap_text("今日は晴れです。明日は雨でしょう。", 10), "今日は晴れです。\n明日は雨でしょう。")

    def test_line_never_starts_with_closing_punctuation(self):
        self.assertEqual(_wrap_text("ああああああああああ。いい", 10), "あああああああああ\nあ。いい")

    def test_spaced_text_still_wraps_at_words(self):
        self.assertEqual(_wrap_text("one two three four", 9), "one two\nthree\nfour")


class FormatterTests(unittest.TestCase):
    def test_write_srt_wraps_long_lines_when_max_line_length_is_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "wrapped.srt"
            segments = [
                SimpleNamespace(
                    start=0.0,
                    end=4.0,
                    text="This sentence should wrap into multiple subtitle lines cleanly.",
                )
            ]

            count = write_srt(segments, output_path, max_line_length=20)

            self.assertEqual(count, 1)
            content = output_path.read_text(encoding="utf-8")
            text_lines = [line for line in content.splitlines()[2:] if line]
            self.assertGreater(len(text_lines), 1)
            self.assertTrue(all(len(line) <= 20 for line in text_lines))


if __name__ == "__main__":
    unittest.main()
