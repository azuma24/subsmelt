import unittest

from app.engine import LanguageNotSupportedError
from app.nemotron_languages import (
    NEMOTRON_SHORT_CODES,
    fold_iso3,
    map_language,
    normalize_language,
    short_code_for,
)


class NemotronLanguageTests(unittest.TestCase):
    def test_short_codes_map_to_locales(self):
        self.assertEqual(map_language("zh"), "zh-CN")
        self.assertEqual(map_language("pt-PT"), "pt-PT")
        self.assertEqual(map_language("pt"), "pt-BR")
        self.assertEqual(map_language("no"), "nb-NO")
        self.assertEqual(map_language("auto"), "auto")
        self.assertEqual(map_language(""), "auto")

    def test_matching_is_case_insensitive(self):
        self.assertEqual(map_language("JA"), "ja-JP")
        self.assertEqual(map_language("Zh-cn"), "zh-CN")

    def test_regional_tags_fold_to_the_base_code(self):
        self.assertEqual(normalize_language("zh-TW"), "zh")
        self.assertEqual(normalize_language("pt-BR"), "pt")
        self.assertEqual(normalize_language("AUTO"), "auto")
        self.assertEqual(normalize_language(""), "")

    def test_regional_chinese_maps_to_the_mandarin_locale_and_known_regions_are_kept(self):
        # The chinese_script request field decides Traditional vs Simplified
        # output; the model only needs to know the audio is Mandarin.
        self.assertEqual(map_language("zh-TW"), "zh-CN")
        self.assertEqual(map_language("pt-PT"), "pt-PT")

    def test_auto_in_any_case_or_blank_means_auto(self):
        self.assertEqual(map_language("AUTO"), "auto")
        self.assertEqual(map_language("  "), "auto")

    def test_unsupported_languages_raise(self):
        for lang in ("el", "he", "th", "xx"):
            with self.assertRaises(LanguageNotSupportedError) as ctx:
                map_language(lang)
            self.assertEqual((ctx.exception.model, ctx.exception.language), ("nemotron-3.5-asr", lang))

    def test_locale_maps_back_to_the_first_short_code(self):
        self.assertEqual(short_code_for("nb-NO"), "nb")
        self.assertEqual(short_code_for("pt-BR"), "pt")
        self.assertEqual(short_code_for("zh-CN"), "zh")
        self.assertEqual(short_code_for("en-US"), "en")
        self.assertIsNone(short_code_for("xx-XX"))

    def test_short_code_list_excludes_auto(self):
        self.assertNotIn("auto", NEMOTRON_SHORT_CODES)
        self.assertEqual(len(NEMOTRON_SHORT_CODES), 32)

    def test_fold_iso3_shortens_three_letter_codes_and_keeps_others_as_given(self):
        self.assertEqual(fold_iso3("kor"), "ko")
        self.assertEqual(fold_iso3(" CHI "), "zh")
        self.assertEqual(fold_iso3("pt-BR"), "pt-BR")
        self.assertEqual(fold_iso3("auto"), "auto")


if __name__ == "__main__":
    unittest.main()
