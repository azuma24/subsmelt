import tempfile
import unittest
from pathlib import Path

try:
    from app.schemas import TranscribeRequest
    from app.transcribe import (
        TranscriptionCancelled,
        fake_transcribe_streaming_for_tests,
    )
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TranscribeRequest = None
    fake_transcribe_streaming_for_tests = None
    TranscriptionCancelled = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
class StreamingTranscriptionTests(unittest.TestCase):
    def _request(self, tmp: str) -> "TranscribeRequest":
        return TranscribeRequest(input_path=str(Path(tmp) / "clip.mkv"), output_format="srt", language="en")

    def test_streaming_emits_progress_then_terminal_result(self):
        # All assertions stay inside the tempdir context: the backend writes the
        # subtitle next to the input, so checking subtitle_path.exists() after the
        # `with` block (which deletes tmp) would spuriously fail.
        with tempfile.TemporaryDirectory() as tmp:
            request = self._request(tmp)
            events = list(fake_transcribe_streaming_for_tests(Path(request.input_path), request))

            progress = [e for e in events if e["type"] == "progress"]
            results = [e for e in events if e["type"] == "result"]

            self.assertGreaterEqual(len(progress), 1)
            self.assertEqual(len(results), 1)
            # Progress percentages are monotonically non-decreasing and bounded.
            pcts = [e["pct"] for e in progress]
            self.assertEqual(pcts, sorted(pcts))
            for e in progress:
                self.assertGreaterEqual(e["pct"], 0.0)
                self.assertLessEqual(e["pct"], 100.0)
                self.assertIn("processedSeconds", e)
                self.assertIn("totalSeconds", e)

            terminal = results[0]
            self.assertTrue(terminal["ok"])
            self.assertGreaterEqual(terminal["segments"], 1)
            self.assertTrue(Path(terminal["subtitle_path"]).exists())

    def test_streaming_cancellation_raises_and_stops_early(self):
        with tempfile.TemporaryDirectory() as tmp:
            request = self._request(tmp)
            gen = fake_transcribe_streaming_for_tests(
                Path(request.input_path), request, is_cancelled=lambda: True
            )
            with self.assertRaises(TranscriptionCancelled):
                list(gen)


if __name__ == "__main__":
    unittest.main()
