import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from app.formatters import write_srt


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
