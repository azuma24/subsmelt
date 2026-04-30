import unittest
from types import SimpleNamespace

from app.schemas import AdvancedSttOptions, TranscribeRequest
from app.transcribe import faster_whisper_transcribe_kwargs, unsupported_advanced_features


class AdvancedOptionsTests(unittest.TestCase):
    def test_supported_advanced_options_become_faster_whisper_kwargs(self):
        request = TranscribeRequest(
            input_path="/media/lecture.mkv",
            language="en",
            use_vad=True,
            advanced_options=AdvancedSttOptions(
                beam_size=7,
                patience=1.2,
                condition_on_previous_text=False,
                word_timestamps=True,
                initial_prompt="Technical lecture.",
            ),
        )

        self.assertEqual(faster_whisper_transcribe_kwargs(request), {
            "language": "en",
            "vad_filter": True,
            "beam_size": 7,
            "patience": 1.2,
            "condition_on_previous_text": False,
            "word_timestamps": True,
            "initial_prompt": "Technical lecture.",
        })

    def test_unsupported_heavy_features_are_explicitly_reported(self):
        request = TranscribeRequest(
            input_path="/media/movie.mkv",
            advanced_options=AdvancedSttOptions(
                speaker_diarization=True,
                bgm_separation=True,
            ),
        )

        self.assertEqual(unsupported_advanced_features(request), ["speaker_diarization", "bgm_separation"])


if __name__ == "__main__":
    unittest.main()
