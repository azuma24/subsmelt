import tempfile
import unittest
from pathlib import Path

from app import nemotron
from app.nemotron_runtime import NemotronHandle
from tests.nemotron_fixtures import can_exec_wrappers, write_fake_binary, write_silent_wav

FFMPEG_STDERR = """\
Input #0, wav, from 'audio.wav':
[silencedetect @ 0x1] silence_start: 12.5
[silencedetect @ 0x1] silence_end: 13.3 | silence_duration: 0.8
[silencedetect @ 0x1] silence_start: 40
[silencedetect @ 0x1] silence_end: 40.7 | silence_duration: 0.7
[silencedetect @ 0x1] silence_start: 99.1
size=N/A time=00:01:40.00 bitrate=N/A speed= 800x
"""


class ChunkPlanningTests(unittest.TestCase):
    def test_parses_silence_pairs_and_ignores_an_open_trailing_one(self):
        self.assertEqual(nemotron.parse_silences(FFMPEG_STDERR), [(12.5, 13.3), (40.0, 40.7)])

    def test_cuts_a_1500s_file_at_the_longest_silence_near_each_10_minute_mark(self):
        silences = [
            (100.0, 100.5),
            (590.0, 591.2),
            (605.0, 605.6),
            (1190.0, 1190.5),
            (1250.0, 1251.0),
            (1400.0, 1400.5),
        ]
        self.assertEqual(
            nemotron.plan_chunks(1500.0, lambda: silences),
            [(0.0, 590.6), (590.6, 1250.5), (1250.5, 1500.0)],
        )

    def test_falls_back_to_the_mark_itself_without_a_nearby_silence(self):
        self.assertEqual(nemotron.plan_chunks(1300.0, lambda: [(100.0, 100.5)]), [(0.0, 600.0), (600.0, 1300.0)])

    def test_no_chunk_exceeds_the_maximum_when_neighbouring_cuts_drift_apart(self):
        chunks = nemotron.plan_chunks(1500.0, lambda: [(480.0, 481.0), (1318.0, 1319.0)])
        self.assertEqual(chunks, [(0.0, 480.5), (480.5, 1080.5), (1080.5, 1500.0)])

    def test_a_700s_file_is_one_chunk_and_never_scans_for_silence(self):
        def never():
            raise AssertionError("silence scan must not run for a short file")

        self.assertEqual(nemotron.plan_chunks(700.0, never), [(0.0, 700.0)])


class WavCuttingTests(unittest.TestCase):
    def test_cut_chunk_keeps_format_and_length(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_silent_wav(Path(tmp) / "audio.wav", 5.0)
            chunk = nemotron.cut_chunk(source, (2.0, 5.0), Path(tmp), 1)
            self.assertEqual(chunk.name, "chunk-001.wav")
            self.assertEqual(nemotron.wav_duration(chunk), 3.0)


@unittest.skipUnless(can_exec_wrappers(), "shell wrappers need a POSIX host")
class ChunkOffsetTests(unittest.TestCase):
    def test_words_from_the_second_chunk_are_offset_by_its_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            handle = NemotronHandle(binary=write_fake_binary(root), gguf=root / "model.gguf")
            handle.gguf.write_bytes(b"GGUF")
            audio = write_silent_wav(root / "audio.wav", 5.0)
            events = nemotron.run_chunks(handle, audio, [(0.0, 2.0), (2.0, 5.0)], 5.0, "auto", "auto", None)
            progress = []
            try:
                while True:
                    progress.append(next(events))
            except StopIteration as done:
                words, locales = done.value
        self.assertEqual(
            progress,
            [
                {"type": "progress", "processedSeconds": 2.0, "totalSeconds": 5.0, "pct": 40.0},
                {"type": "progress", "processedSeconds": 5.0, "totalSeconds": 5.0, "pct": 100.0},
            ],
        )
        self.assertEqual(
            [(w.text, w.start, w.end) for w in words],
            [
                ("word0", 0.0, 0.4),
                ("word1", 0.5, 0.9),
                ("word2", 1.0, 1.4),
                ("word3", 1.5, 1.9),
                ("word0", 2.0, 2.4),
                ("word1", 2.5, 2.9),
                ("word2", 3.0, 3.4),
                ("word3", 3.5, 3.9),
                ("word4", 4.0, 4.4),
                ("word5", 4.5, 4.9),
            ],
        )
        self.assertEqual(locales, ["en-US", "en-US"])
        self.assertEqual([p.name for p in Path(tempfile.gettempdir()).glob("subsmelt-nemo-*")], [])

    def test_missing_model_becomes_a_runtime_error_with_the_binary_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            handle = NemotronHandle(binary=write_fake_binary(root), gguf=root / "absent.gguf")
            audio = write_silent_wav(root / "audio.wav", 1.0)
            with self.assertRaises(RuntimeError) as ctx:
                nemotron.transcribe_chunk(handle, audio, "en-US", "auto", None)
        self.assertEqual(
            str(ctx.exception), f"nemo-speech failed: ASR model file does not exist: {root / 'absent.gguf'}"
        )


if __name__ == "__main__":
    unittest.main()
