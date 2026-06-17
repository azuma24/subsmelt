import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from app.formatters import write_srt, write_transcript


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
