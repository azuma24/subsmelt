import unittest
from types import SimpleNamespace

from app.segments import (
    Segment,
    merge_short_segments,
    postprocess_segments,
    split_long_segments,
)


def seg(start, end, text):
    return Segment(start=start, end=end, text=text)


class MergeShortSegmentsTests(unittest.TestCase):
    def test_no_short_segments_is_noop(self):
        segments = [seg(0.0, 3.0, "Hello there friend"), seg(3.0, 6.0, "How are you today")]
        self.assertEqual(merge_short_segments(segments), segments)

    def test_short_segment_merges_into_following(self):
        # "Oh" is brief in time and chars -> folds into the next cue.
        segments = [seg(0.0, 0.4, "Oh"), seg(0.4, 3.0, "that is wonderful news")]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(0.0, 3.0, "Oh that is wonderful news")])

    def test_trailing_short_segment_merges_into_previous(self):
        segments = [seg(0.0, 3.0, "Goodbye for now"), seg(3.0, 3.3, "bye")]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(0.0, 3.3, "Goodbye for now bye")])

    def test_consecutive_short_segments_chain_together(self):
        segments = [seg(0.0, 0.4, "Um"), seg(0.4, 0.8, "uh"), seg(0.8, 4.0, "okay let us begin")]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(0.0, 4.0, "Um uh okay let us begin")])

    def test_all_short_segments_collapse_to_one(self):
        segments = [seg(0.0, 0.3, "a"), seg(0.3, 0.6, "b")]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(0.0, 0.6, "a b")])

    def test_long_duration_but_few_chars_is_not_merged(self):
        # 2.0s exceeds the duration threshold, so it stays even though it's short text.
        segments = [seg(0.0, 2.0, "Yes"), seg(2.0, 5.0, "I agree with that")]
        self.assertEqual(merge_short_segments(segments), segments)


class SplitLongSegmentsTests(unittest.TestCase):
    def test_disabled_when_max_duration_falsy(self):
        segments = [seg(0.0, 10.0, "one two three four")]
        self.assertEqual(split_long_segments(segments, None), segments)
        self.assertEqual(split_long_segments(segments, 0), segments)

    def test_segment_within_limit_is_unchanged(self):
        segments = [seg(0.0, 3.0, "short enough")]
        self.assertEqual(split_long_segments(segments, 5.0), segments)

    def test_long_segment_splits_evenly_at_word_boundaries(self):
        # 8s with max 4s -> 2 chunks of 4s each, words split proportionally.
        segments = [seg(0.0, 8.0, "alpha bravo charlie delta")]
        result = split_long_segments(segments, 4.0)
        self.assertEqual(
            result,
            [seg(0.0, 4.0, "alpha bravo"), seg(4.0, 8.0, "charlie delta")],
        )

    def test_three_way_split(self):
        # 9s with max 3s -> 3 chunks of 3s each.
        segments = [seg(0.0, 9.0, "a b c d e f")]
        result = split_long_segments(segments, 3.0)
        self.assertEqual(
            result,
            [seg(0.0, 3.0, "a b"), seg(3.0, 6.0, "c d"), seg(6.0, 9.0, "e f")],
        )

    def test_split_never_loses_words(self):
        segments = [seg(0.0, 10.0, "one two three four five six seven")]
        result = split_long_segments(segments, 3.0)
        joined = " ".join(s.text for s in result)
        self.assertEqual(joined.split(), "one two three four five six seven".split())


class PostprocessPipelineTests(unittest.TestCase):
    def test_neither_option_returns_normalized_unchanged(self):
        raw = [SimpleNamespace(start=0.0, end=2.0, text="hello world")]
        result = postprocess_segments(raw)
        self.assertEqual(result, [seg(0.0, 2.0, "hello world")])

    def test_merge_then_split_compose_in_order(self):
        # Short "Oh" merges into a long cue, which then splits by duration.
        raw = [
            SimpleNamespace(start=0.0, end=0.4, text="Oh"),
            SimpleNamespace(start=0.4, end=8.0, text="this is a rather long sentence indeed"),
        ]
        result = postprocess_segments(raw, merge_short=True, max_subtitle_duration=4.0)
        # After merge: one 8s cue "Oh this is a rather long sentence indeed".
        # After split (8s / 4s -> 2 chunks): two ~4s cues.
        self.assertEqual(len(result), 2)
        self.assertAlmostEqual(result[0].start, 0.0)
        self.assertAlmostEqual(result[1].end, 8.0)
        joined = " ".join(s.text for s in result)
        self.assertEqual(joined, "Oh this is a rather long sentence indeed")


if __name__ == "__main__":
    unittest.main()
