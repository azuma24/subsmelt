import unittest

try:
    from app.engine import LanguageNotSupportedError
    from app.schemas import AdvancedSttOptions, TranscribeRequest
    from app.transcribe import (
        assert_language_supported,
        assert_supported_advanced_features,
        unsupported_advanced_features,
    )
    from app.whisper_engine import faster_whisper_transcribe_kwargs
    from app.nemotron_languages import map_language
except ModuleNotFoundError as exc:  # pragma: no cover - local host may not have backend deps installed
    AdvancedSttOptions = None
    TranscribeRequest = None
    LanguageNotSupportedError = None
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
        with self.assertRaises(LanguageNotSupportedError) as ctx:
            assert_language_supported(request)
        self.assertEqual(
            str(ctx.exception),
            "Model 'distil-large-v3' does not support language 'ja'. Use large-v3 or large-v3-turbo.",
        )
        self.assertEqual((ctx.exception.model, ctx.exception.language), ("distil-large-v3", "ja"))
        with self.assertRaises(LanguageNotSupportedError):
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

    def test_nemotron_rejects_traditional_chinese_and_accepts_japanese(self):
        assert_language_supported(TranscribeRequest(input_path="/media/a.mkv", model="nemotron-3.5-asr", language="ja"))
        with self.assertRaises(LanguageNotSupportedError) as ctx:
            assert_language_supported(TranscribeRequest(input_path="/media/a.mkv", model="nemotron-3.5-asr", language="zh-TW"))
        self.assertEqual(ctx.exception.language, "zh-TW")

    def test_word_timestamps_default_on_without_advanced_options(self):
        # Word timestamps are what lets cues snap to the moment words are
        # actually spoken; without them the opening cue stretches back to 0:00.
        request = TranscribeRequest(input_path="/media/lecture.mkv", language="auto")
        kwargs = faster_whisper_transcribe_kwargs(request)
        self.assertEqual(kwargs["word_timestamps"], True)
        self.assertEqual(kwargs["language"], None)

    def test_word_timestamps_can_be_explicitly_disabled(self):
        request = TranscribeRequest(
            input_path="/media/lecture.mkv",
            language="en",
            advanced_options=AdvancedSttOptions(word_timestamps=False),
        )
        self.assertEqual(faster_whisper_transcribe_kwargs(request)["word_timestamps"], False)

    def test_three_letter_iso_codes_are_normalized_before_the_gate(self):
        # A saved setting can carry the 3-letter form the translation tasks use
        # ("kor"): the catalog only lists short codes, so without normalization
        # Nemotron refuses Korean even though the model speaks it, and
        # faster-whisper cannot parse "kor" either.
        request = TranscribeRequest(input_path="/media/talk.mkv", model="nemotron-3.5-asr", language="kor")
        assert_language_supported(request)
        whisper = TranscribeRequest(input_path="/media/talk.mkv", model="small", language="kor")
        assert_language_supported(whisper)
        self.assertEqual(faster_whisper_transcribe_kwargs(whisper)["language"], "ko")
        self.assertEqual(map_language("kor"), "ko-KR")
