"""Diarization unit tests that need neither pyannote nor torch."""

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from app import diarize
from app.formatters import write_ass, write_srt, write_txt


class LabelAssignmentTests(unittest.TestCase):
    def test_overlap(self):
        self.assertEqual(diarize._overlap(0, 10, 5, 15), 5)
        self.assertEqual(diarize._overlap(0, 4, 6, 9), 0)

    def test_label_for_picks_max_overlap(self):
        turns = [(0.0, 2.0, "SPEAKER_00"), (1.5, 5.0, "SPEAKER_01")]
        # [1.6, 4.0] overlaps SPEAKER_01 far more than SPEAKER_00.
        self.assertEqual(diarize._label_for(1.6, 4.0, turns), "SPEAKER_01")
        # [0.0, 1.0] only touches SPEAKER_00.
        self.assertEqual(diarize._label_for(0.0, 1.0, turns), "SPEAKER_00")
        # No overlap → None.
        self.assertIsNone(diarize._label_for(10.0, 11.0, turns))

    def test_fake_assign_speakers_alternates_and_copies(self):
        segs = [SimpleNamespace(start=0.0, end=1.0, text="a"),
                SimpleNamespace(start=1.0, end=2.0, text="b")]
        out = diarize.fake_assign_speakers(segs)
        self.assertEqual([s.speaker for s in out], ["SPEAKER_00", "SPEAKER_01"])
        self.assertEqual(out[0].text, "a")
        # New objects, not the originals (originals may be immutable).
        self.assertIsNot(out[0], segs[0])


class AvailabilityTests(unittest.TestCase):
    def test_unavailable_without_token(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SUBSMELT_HF_TOKEN", None)
            os.environ.pop("HF_TOKEN", None)
            self.assertFalse(diarize.diarize_available())

    def test_get_pipeline_raises_clear_error_without_token(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SUBSMELT_HF_TOKEN", None)
            os.environ.pop("HF_TOKEN", None)
            with self.assertRaises(diarize.DiarizationTokenMissingError):
                diarize._get_pipeline("cpu")


class FormatterSpeakerTests(unittest.TestCase):
    def _segs(self):
        return [SimpleNamespace(start=0.0, end=1.0, text="hello", speaker="SPEAKER_00"),
                SimpleNamespace(start=1.0, end=2.0, text="world", speaker="SPEAKER_01")]

    def test_srt_prefixes_speaker(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "a.srt"
            write_srt(self._segs(), out)
            body = out.read_text()
            self.assertIn("[SPEAKER_00] hello", body)
            self.assertIn("[SPEAKER_01] world", body)

    def test_txt_prefixes_speaker(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "a.txt"
            write_txt(self._segs(), out)
            self.assertIn("[SPEAKER_00] hello", out.read_text())

    def test_ass_uses_name_field_not_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "a.ass"
            write_ass(self._segs(), out)
            body = out.read_text()
            # Speaker in the Name/actor field, not prefixed into the text.
            self.assertIn(",SPEAKER_00,", body)
            self.assertNotIn("[SPEAKER_00]", body)

    def test_no_speaker_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "a.srt"
            write_srt([SimpleNamespace(start=0.0, end=1.0, text="plain")], out)
            body = out.read_text()
            self.assertIn("plain", body)
            self.assertNotIn("[", body)


if __name__ == "__main__":
    unittest.main()
