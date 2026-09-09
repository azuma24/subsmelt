import unittest

try:
    from app.schemas import AdvancedSttOptions, TranscribeRequest
    from app.transcribe import (
        EnglishOnlyModelError,
        assert_language_supported,
        assert_supported_advanced_features,
        faster_whisper_transcribe_kwargs,
        unsupported_advanced_features,
    )
except ModuleNotFoundError as exc:  # pragma: no cover - local host may not have backend deps installed
    AdvancedSttOptions = None
    TranscribeRequest = None
    EnglishOnlyModelError = None
    assert_language_supported = None
    assert_supported_advanced_features = None
    faster_whisper_transcribe_kwargs = None
    unsupported_advanced_features = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
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
        # bgm_separation has no implementation, so it is always reported here.
        # speaker_diarization is NOT: it is a real (optional) pipeline gated at
        # the capability level by pyannote + an HF token, so requesting it is
        # valid whenever the backend advertises it.
        request = TranscribeRequest(
            input_path="/media/movie.mkv",
            advanced_options=AdvancedSttOptions(
                speaker_diarization=True,
                bgm_separation=True,
            ),
        )

        self.assertEqual(unsupported_advanced_features(request), ["bgm_separation"])

    def test_distil_rejects_non_english_language(self):
        request = TranscribeRequest(
            input_path="/media/anime.mkv",
            model="distil-large-v3",
            language="ja",
        )
        with self.assertRaises(EnglishOnlyModelError) as ctx:
            assert_language_supported(request)
        self.assertIn("English-only", str(ctx.exception))
        with self.assertRaises(EnglishOnlyModelError):
            assert_supported_advanced_features(request)

    def test_distil_allows_english_and_auto(self):
        for lang in ("en", "auto"):
            request = TranscribeRequest(
                input_path="/media/talk.mkv",
                model="distil-large-v3",
                language=lang,
            )
            assert_language_supported(request)

    def test_multilingual_model_allows_japanese(self):
        request = TranscribeRequest(
            input_path="/media/anime.mkv",
            model="large-v3-turbo",
            language="ja",
        )
        assert_language_supported(request)


if __name__ == "__main__":
    unittest.main()
