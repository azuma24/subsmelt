import unittest

from app.engine import LanguageNotSupportedError
from app.nemotron_languages import NEMOTRON_SHORT_CODES, map_language, short_code_for


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

    def test_unsupported_languages_raise(self):
        for lang in ("zh-TW", "el", "he", "th", "xx"):
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


if __name__ == "__main__":
    unittest.main()
