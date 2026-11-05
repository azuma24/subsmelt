"""The whisper.cpp engine runner: whisper-cli on Metal, one child process per
transcription, progress from its stderr lines, segments from its out.json."""

import stat
import sys
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from app import whispercpp
from app.engine import EngineUnavailableError, TranscriptionCancelled
from app.schemas import TranscribeRequest
from app.whispercpp_runtime import WhisperCppHandle, load_handle
from app.word_timing import Word
from tests.nemotron_fixtures import can_exec_wrappers, write_silent_wav

FAKE_CLI = Path(__file__).resolve().parent / "fake_whisper_cli.py"


def _write_wrapper(directory: Path) -> Path:
    wrapper = directory / "whisper-cli"
    wrapper.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_CLI}" "$@"\n', encoding="utf-8")
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    return wrapper


def _drain(generator):
    events = []
    while True:
        try:
            events.append(next(generator))
        except StopIteration as done:
            return events, done.value


def _request(**overrides) -> TranscribeRequest:
    base = {"input_path": "clip.mkv", "model": "whispercpp-large-v3-turbo", "language": "auto"}
    return TranscribeRequest(**{**base, **overrides})


@unittest.skipUnless(can_exec_wrappers(), "shell wrappers need a POSIX host")
class WhisperCppRunnerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.binary = _write_wrapper(self.tmp)
        self.weights = self.tmp / "ggml-large-v3-turbo.bin"
        self.weights.write_bytes(b"GGML")
        self.wav = write_silent_wav(self.tmp / "audio.wav", 2.0)

    def _run(self, request, is_cancelled=None):
        handle = WhisperCppHandle(binary=self.binary, weights=self.weights)

        @contextmanager
        def fake_lease(model, device, compute_type):
            yield handle

        with mock.patch.object(whispercpp, "lease", fake_lease):
            return _drain(whispercpp.run(request, self.wav, is_cancelled, 0.5))

    def test_progress_events_and_segments_match_the_fixture(self):
        events, (segments, info) = self._run(_request())

        self.assertEqual([event["pct"] for event in events], [0.0, 50.0, 100.0])
        self.assertEqual(
            [(round(segment.start, 3), round(segment.end, 3), segment.text) for segment in segments],
            [(0.0, 1.0, " Hello from whisper.cpp."), (1.0, 2.0, " Second cue.")],
        )
        self.assertEqual(info.language, "en")
        self.assertEqual(info.duration, 2.0)

    def test_word_offsets_are_opt_in_and_can_be_disabled(self):
        _, (default_segments, _) = self._run(_request())
        _, (quality_segments, _) = self._run(_request(subtitle_quality={"max_subtitle_duration": 1.0}))
        _, (explicit_segments, _) = self._run(_request(advanced_options={"word_timestamps": True}))
        _, (disabled_segments, _) = self._run(
            _request(subtitle_quality={"max_subtitle_duration": 1.0}, advanced_options={"word_timestamps": False})
        )
        self.assertEqual(default_segments[0].words, ())
        self.assertEqual(quality_segments[0].start, 0.0)
        self.assertEqual(
            quality_segments[0].words,
            (Word(" Hello", 0.1, 0.3), Word(" from", 0.3, 0.5), Word(" whisper.cpp.", 0.5, 0.9)),
        )
        self.assertEqual(explicit_segments[0].start, 0.1)
        self.assertEqual(disabled_segments[0].words, ())

    def test_prompt_and_beam_size_reach_the_command_line(self):
        seen = {}

        real_popen = __import__("subprocess").Popen

        def popen_capture(command, *args, **kwargs):
            seen["command"] = command
            return real_popen(command, *args, **kwargs)

        with mock.patch("subprocess.Popen", popen_capture):
            self._run(_request(advanced_options={"initial_prompt": "SubSmelt.", "beam_size": 5}))

        command = seen["command"]
        self.assertIn("--prompt", command)
        self.assertEqual(command[command.index("--prompt") + 1], "SubSmelt.")
        self.assertEqual(command[command.index("-bs") + 1], "5")

    def test_a_cancel_kills_the_child_quickly(self):
        started = time.monotonic()
        with mock.patch.dict("os.environ", {"SUBSMELT_FAKE_WHISPER_SLEEP": "30"}):
            with self.assertRaises(TranscriptionCancelled):
                self._run(_request(), lambda: True)
        self.assertLess(time.monotonic() - started, 5.0)


class TokenOffsetTests(unittest.TestCase):
    def test_split_utf8_and_mixed_latin_subwords_keep_text_and_offsets(self):
        encoded = "貓".encode()
        lead, tail = [part.decode("utf-8", errors="surrogateescape") for part in (encoded[:2], encoded[2:])]
        tokens = [
            {"text": text, "offsets": {"from": start, "to": end}}
            for text, start, end in (
                ("[_BEG_]", 0, 0),
                (lead, 100, 120),
                (tail, 130, 180),
                ("Whis", 180, 230),
                ("per", 230, 300),
                ("。", 300, 320),
            )
        ]
        self.assertEqual(
            whispercpp._token_words(tokens, "貓Whisper。"),
            (Word("貓", 0.1, 0.18), Word("Whisper", 0.18, 0.3), Word("。", 0.3, 0.32)),
        )

    def test_bad_token_offsets_fall_back_to_segment_text(self):
        for bad in (
            {},
            {"from": 500, "to": 200},
            {"from": -1, "to": 300},
            {"from": 0, "to": 0},
            {"from": 200, "to": 900},
        ):
            with self.subTest(offsets=bad):
                result = whispercpp._segments_from(
                    {
                        "transcription": [
                            {
                                "text": " Test.",
                                "offsets": {"from": 0, "to": 800},
                                "tokens": [{"text": " Test.", "offsets": bad}],
                            }
                        ]
                    },
                    with_words=True,
                )
                self.assertEqual(
                    (result[0].start, result[0].end, result[0].text, result[0].words), (0.0, 0.8, " Test.", ())
                )


class WhisperCppHandleTests(unittest.TestCase):
    def test_a_missing_binary_raises_engine_unavailable(self):
        with mock.patch.dict("os.environ", {"SUBSMELT_WHISPER_CPP": "/nowhere/whisper-cli"}):
            with self.assertRaises(EngineUnavailableError):
                load_handle(Path("/nowhere/ggml-large-v3-turbo.bin"))


if __name__ == "__main__":
    unittest.main()
