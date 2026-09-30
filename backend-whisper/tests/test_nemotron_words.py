import unittest

from app.nemotron_words import Word, words_to_segments
from app.schemas import SubtitleQualityOptions

# The first 40 words nemo-speech produced for ted.wav (proto-nemo/ted.nemo.json).
TED_WORDS = [
    ("Why", 7.36, 7.44), ("does", 7.52, 7.6), ("your", 7.6, 7.68), ("mouth", 7.76, 7.92),
    ("feel", 8.0, 8.16), ("like", 8.16, 8.24), ("it's", 8.4, 8.72), ("on", 8.96, 9.04),
    ("fire", 9.04, 9.2), ("when", 9.36, 9.44), ("you", 9.52, 9.6), ("eat", 9.6, 9.68),
    ("a", 9.92, 10.0), ("spicy", 10.0, 10.24), ("pepper,", 10.32, 11.36), ("and", 11.28, 11.36),
    ("how", 11.44, 11.52), ("do", 11.6, 11.68), ("you", 11.68, 11.76), ("soothe", 11.92, 12.32),
    ("the", 12.4, 12.48), ("burn?", 12.48, 12.96), ("Why", 13.12, 13.2), ("does", 13.28, 13.36),
    ("Wasabi", 13.6, 14.0), ("make", 14.08, 14.16), ("your", 14.24, 14.32), ("eyes", 14.4, 14.56),
    ("water", 14.64, 14.88), ("and", 15.44, 15.52), ("how", 15.68, 15.76), ("spicy", 16.0, 16.16),
    ("is", 16.4, 16.48), ("the", 16.72, 16.8), ("spiciest", 16.96, 17.6), ("spice?", 17.76, 18.4),
    ("Let's", 18.48, 18.64), ("back", 18.64, 18.72), ("up", 18.8, 18.88), ("a", 18.96, 19.04),
]


def _words(rows):
    return [Word(text=text, start=start, end=end) for text, start, end in rows]


def _cues(segments):
    return [(segment.start, segment.end, segment.text) for segment in segments]


class WordsToSegmentsTests(unittest.TestCase):
    def test_english_sample_breaks_at_sentences_and_at_the_84_char_limit_on_a_comma(self):
        self.assertEqual(
            _cues(words_to_segments(_words(TED_WORDS), None)),
            [
                (7.36, 11.36, "Why does your mouth feel like it's on fire when you eat a spicy pepper,"),
                (11.36, 12.96, "and how do you soothe the burn?"),
                (13.12, 18.4, "Why does Wasabi make your eyes water and how spicy is the spiciest spice?"),
                (18.48, 19.04, "Let's back up a"),
            ],
        )

    def test_japanese_joins_without_spaces_and_cuts_at_32_characters(self):
        rows = [
            ("東京都は", 0.0, 0.4), ("今日も雨", 0.5, 0.9), ("明日は晴", 1.0, 1.4), ("週末は雪", 1.5, 1.9),
            ("来週は風", 2.0, 2.4), ("気温は低", 2.5, 2.9), ("湿度は高", 3.0, 3.4), ("風速は強", 3.5, 3.9),
            ("波は高い", 4.0, 4.4), ("注意です。", 4.5, 4.9),
        ]
        self.assertEqual(
            _cues(words_to_segments(_words(rows), None)),
            [
                (0.0, 3.9, "東京都は今日も雨明日は晴週末は雪来週は風気温は低湿度は高風速は強"),
                (4.0, 4.9, "波は高い注意です。"),
            ],
        )

    def test_latin_and_wide_words_keep_a_space_between_them(self):
        rows = [("Hello", 0.0, 0.3), ("世界。", 0.4, 0.8), ("世界", 1.0, 1.2), ("hello", 1.3, 1.6)]
        self.assertEqual(
            _cues(words_to_segments(_words(rows), None)),
            [(0.0, 0.8, "Hello 世界。"), (1.0, 1.6, "世界 hello")],
        )

    def test_a_pause_over_600ms_splits(self):
        rows = [("a", 0.0, 0.3), ("b", 1.0, 1.3), ("c", 1.8, 2.1), ("d", 2.8, 3.1)]
        self.assertEqual(
            _cues(words_to_segments(_words(rows), None)),
            [(0.0, 0.3, "a"), (1.0, 2.1, "b c"), (2.8, 3.1, "d")],
        )

    def test_default_six_second_limit_splits_a_run_without_punctuation(self):
        rows = [(f"w{i}", float(i), i + 0.5) for i in range(8)]
        self.assertEqual(
            _cues(words_to_segments(_words(rows), None)),
            [(0.0, 5.5, "w0 w1 w2 w3 w4 w5"), (6.0, 7.5, "w6 w7")],
        )

    def test_subtitle_quality_duration_limit_is_honoured(self):
        rows = [(f"w{i}", float(i), i + 0.5) for i in range(8)]
        quality = SubtitleQualityOptions(max_subtitle_duration=2.0)
        self.assertEqual(
            _cues(words_to_segments(_words(rows), quality)),
            [(0.0, 1.5, "w0 w1"), (2.0, 3.5, "w2 w3"), (4.0, 5.5, "w4 w5"), (6.0, 7.5, "w6 w7")],
        )

    def test_subtitle_quality_line_length_doubles_into_the_cue_limit(self):
        rows = [("alpha,", 0.0, 0.2), ("beta", 0.3, 0.5), ("gamma", 0.6, 0.8), ("delta", 0.9, 1.1)]
        quality = SubtitleQualityOptions(max_line_length=8)
        self.assertEqual(
            _cues(words_to_segments(_words(rows), quality)),
            [(0.0, 0.5, "alpha, beta"), (0.6, 1.1, "gamma delta")],
        )


if __name__ == "__main__":
    unittest.main()
