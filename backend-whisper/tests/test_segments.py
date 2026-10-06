import unittest
from types import SimpleNamespace

from app.segments import (
    Segment,
    clamp_to_duration,
    merge_short_segments,
    postprocess_segments,
    snap_start_to_words,
    split_long_segments,
)


def seg(start, end, text):
    return Segment(start=start, end=end, text=text)


class MergeShortSegmentsTests(unittest.TestCase):
    def test_no_short_segments_is_noop(self):
        segments = [seg(0.0, 3.0, "Hello there friend"), seg(3.0, 6.0, "How are you today")]
        self.assertEqual(merge_short_segments(segments), segments)

    def test_short_segment_merges_into_following(self):
        # "Oh" is brief in time and chars -> folds into the next cue, on the
        # next cue's clock (0.4 — when that text is actually spoken).
        segments = [seg(0.0, 0.4, "Oh"), seg(0.4, 3.0, "that is wonderful news")]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(0.4, 3.0, "Oh that is wonderful news")])

    def test_leading_short_segment_does_not_pin_following_to_zero(self):
        # Audio opens with silence or music: the tiny lead-in sits at 0:00 while
        # the real sentence starts at 2.0. The merged cue must follow the speech,
        # not drag it back to the file start.
        segments = [seg(0.0, 0.4, "Oh"), seg(2.0, 5.0, "welcome back to the show")]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(2.0, 5.0, "Oh welcome back to the show")])

    def test_trailing_short_segment_merges_into_previous(self):
        segments = [seg(0.0, 3.0, "Goodbye for now"), seg(3.0, 3.3, "bye")]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(0.0, 3.3, "Goodbye for now bye")])

    def test_consecutive_short_segments_chain_together(self):
        segments = [seg(0.0, 0.4, "Um"), seg(0.4, 0.8, "uh"), seg(0.8, 4.0, "okay let us begin")]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(0.8, 4.0, "Um uh okay let us begin")])

    def test_all_short_segments_collapse_to_one(self):
        segments = [seg(0.0, 0.3, "a"), seg(0.3, 0.6, "b")]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(0.3, 0.6, "a b")])

    def test_run_of_short_cues_does_not_collapse_onto_the_last_one(self):
        # Five 1 s cues, each short on its own. A forward merge sits on the
        # newest cue's clock, so the carry's own duration never grows; the
        # "still short" test must measure the whole run or all five fold into
        # one cue timed to the final second, hiding four seconds of speech.
        segments = [
            seg(0.0, 1.0, "a"),
            seg(1.0, 2.0, "b"),
            seg(2.0, 3.0, "c"),
            seg(3.0, 4.0, "d"),
            seg(4.0, 5.0, "e"),
        ]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(1.0, 2.0, "a b"), seg(3.0, 5.0, "c d e")])

    def test_long_run_of_short_cues_merges_in_pairs(self):
        # 100 one-second cues: two of them already exceed the 1.5 s threshold,
        # so the run resolves to 50 pairs, each on its second cue's clock.
        segments = [seg(float(i), float(i + 1), "a") for i in range(100)]
        result = merge_short_segments(segments)
        self.assertEqual(result, [seg(float(i), float(i + 1), "a a") for i in range(1, 100, 2)])

    def test_long_duration_but_few_chars_is_not_merged(self):
        # 2.0s exceeds the duration threshold, so it stays even though it's short text.
        segments = [seg(0.0, 2.0, "Yes"), seg(2.0, 5.0, "I agree with that")]
        self.assertEqual(merge_short_segments(segments), segments)


class MergeAcrossSpeakersTests(unittest.TestCase):
    def test_short_segment_is_not_folded_into_another_speaker(self):
        segments = [
            Segment(0.0, 0.8, "Yes.", speaker="SPEAKER_00"),
            Segment(0.8, 6.0, "and then we went to the market together", speaker="SPEAKER_01"),
        ]
        self.assertEqual(merge_short_segments(segments), segments)

    def test_trailing_short_segment_of_another_speaker_stays_separate(self):
        segments = [
            Segment(0.0, 3.0, "Goodbye for now", speaker="SPEAKER_00"),
            Segment(3.0, 3.3, "bye", speaker="SPEAKER_01"),
        ]
        self.assertEqual(merge_short_segments(segments), segments)

    def test_same_speaker_short_segments_still_merge(self):
        segments = [
            Segment(0.0, 0.4, "Oh", speaker="SPEAKER_00"),
            Segment(0.4, 3.0, "that is wonderful news", speaker="SPEAKER_00"),
        ]
        self.assertEqual(
            merge_short_segments(segments),
            [Segment(0.4, 3.0, "Oh that is wonderful news", speaker="SPEAKER_00")],
        )


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
        self.assertEqual(joined.split(), ["one", "two", "three", "four", "five", "six", "seven"])


class SplitUnspacedTextTests(unittest.TestCase):
    def test_unspaced_long_segment_splits_by_characters(self):
        text = "これは日本語の長い字幕テキストで空白がありません"
        result = split_long_segments([seg(0.0, 30.0, text)], 5.0)
        self.assertEqual(
            result,
            [
                seg(0.0, 5.0, "これは日"),
                seg(5.0, 10.0, "本語の長"),
                seg(10.0, 15.0, "い字幕テ"),
                seg(15.0, 20.0, "キストで"),
                seg(20.0, 25.0, "空白があ"),
                seg(25.0, 30.0, "りません"),
            ],
        )

    def test_single_latin_word_is_left_whole(self):
        for text in ("Applause", "https://example.com/a/very/long/path"):
            segments = [seg(0.0, 30.0, text)]
            self.assertEqual(split_long_segments(segments, 5.0), segments)


class PostprocessPipelineTests(unittest.TestCase):
    def test_neither_option_returns_normalized_unchanged(self):
        raw = [SimpleNamespace(start=0.0, end=2.0, text="hello world")]
        result = postprocess_segments(raw)
        self.assertEqual(result, [seg(0.0, 2.0, "hello world")])

    def test_merge_then_split_compose_in_order(self):
        # Short "Oh" merges into a long cue (on the long cue's clock, 0.4),
        # which then splits by duration.
        raw = [
            SimpleNamespace(start=0.0, end=0.4, text="Oh"),
            SimpleNamespace(start=0.4, end=8.0, text="this is a rather long sentence indeed"),
        ]
        result = postprocess_segments(raw, merge_short=True, max_subtitle_duration=4.0)
        # After merge: one 0.4-8.0 cue "Oh this is a rather long sentence indeed".
        # After split (7.6s / 4s -> 2 chunks): two ~3.8s cues.
        self.assertEqual(len(result), 2)
        self.assertAlmostEqual(result[0].start, 0.4)
        self.assertAlmostEqual(result[1].end, 8.0)
        joined = " ".join(s.text for s in result)
        self.assertEqual(joined, "Oh this is a rather long sentence indeed")


if __name__ == "__main__":
    unittest.main()


class ClampToDurationTests(unittest.TestCase):
    def test_cue_starting_after_the_audio_end_is_dropped(self):
        # Trailing-silence hallucination: the model kept "speaking" past the file.
        segments = [
            seg(10.0, 14.0, "real closing words"),
            seg(14.5, 16.0, "Thanks for watching and subscribe below"),
        ]
        self.assertEqual(
            clamp_to_duration(segments, 14.2),
            [seg(10.0, 14.0, "real closing words")],
        )

    def test_straddling_cue_is_truncated_to_the_audio_end(self):
        segments = [seg(12.0, 15.0, "the final sentence of the episode")]
        self.assertEqual(clamp_to_duration(segments, 14.0), [seg(12.0, 14.0, "the final sentence of the episode")])

    def test_in_range_cues_are_untouched(self):
        segments = [seg(0.0, 0.4, "Oh"), seg(2.0, 5.0, "welcome back")]
        self.assertEqual(clamp_to_duration(segments, 600.0), segments)

    def test_unknown_or_zero_duration_leaves_segments_untouched(self):
        segments = [seg(10.0, 14.0, "words"), seg(99.0, 120.0, "past the end")]
        self.assertEqual(clamp_to_duration(segments, None), segments)
        self.assertEqual(clamp_to_duration(segments, 0.0), segments)

    def test_real_speech_just_before_the_end_survives_the_clamp(self):
        segments = [seg(598.0, 600.5, "good night everybody")]
        self.assertEqual(clamp_to_duration(segments, 600.0), [seg(598.0, 600.0, "good night everybody")])


class SnapStartToWordsTests(unittest.TestCase):
    def test_first_cue_snaps_to_when_the_first_word_is_spoken(self):
        # Lead-in silence: the model pinned the opening cue to 0:00, but its
        # first word was measured at 2.1.
        item = SimpleNamespace(
            start=0.0,
            end=4.0,
            text="welcome back to the show",
            words=[
                SimpleNamespace(start=2.1, end=2.5, word="welcome"),
                SimpleNamespace(start=2.6, end=3.9, word="show"),
            ],
        )
        snapped = snap_start_to_words(item)
        self.assertEqual(snapped.start, 2.1)
        self.assertEqual(snapped.end, 4.0)
        self.assertEqual(snapped.text, "welcome back to the show")
        self.assertEqual(len(snapped.words), 2)

    def test_without_words_or_without_late_first_word_nothing_changes(self):
        plain = SimpleNamespace(start=0.0, end=3.0, text="hello", words=None)
        self.assertIs(snap_start_to_words(plain), plain)

        # The first word already starts at/before the cue start: nothing to fix.
        at_zero = SimpleNamespace(
            start=0.0, end=3.0, text="hello", words=[SimpleNamespace(start=0.0, end=0.5, word="hello")]
        )
        self.assertIs(snap_start_to_words(at_zero), at_zero)

    def test_speaker_is_preserved_through_the_snap(self):
        item = SimpleNamespace(
            start=0.0,
            end=4.0,
            text="welcome back",
            words=[SimpleNamespace(start=1.5, end=2.0, word="welcome")],
            speaker="SPEAKER_00",
        )
        self.assertEqual(snap_start_to_words(item).speaker, "SPEAKER_00")

    def test_a_first_word_at_or_after_the_cue_end_leaves_the_timing_alone(self):
        # Word timestamps can drift to or past their own segment's end. Snapping
        # there would make a zero-length (never shown) or inverted cue, so the
        # segment keeps its own timing.
        for word_start in (3.0, 3.4):
            item = SimpleNamespace(
                start=1.0,
                end=3.0,
                text="late",
                words=[SimpleNamespace(start=word_start, end=3.8, word="late")],
            )
            snapped = snap_start_to_words(item)
            self.assertEqual((snapped.start, snapped.end), (1.0, 3.0))
