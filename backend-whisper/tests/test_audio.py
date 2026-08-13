import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app import audio


class ExtractAudioRobustnessTests(unittest.TestCase):
    def test_timeout_raises_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "audio.wav"
            with mock.patch(
                "app.audio.subprocess.run",
                side_effect=subprocess.TimeoutExpired(cmd="ffmpeg", timeout=5),
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    audio.extract_audio(Path("/media/movie.mkv"), out, timeout_seconds=5)
            self.assertIn("timed out", str(ctx.exception))

    def test_nonzero_exit_includes_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "audio.wav"
            fake = mock.Mock(returncode=1, stderr=b"some opaque ffmpeg failure")
            with mock.patch("app.audio.subprocess.run", return_value=fake):
                with self.assertRaises(RuntimeError) as ctx:
                    audio.extract_audio(Path("/media/movie.mkv"), out)
            message = str(ctx.exception)
            self.assertIn("exit code 1", message)
            self.assertIn("some opaque ffmpeg failure", message)

    def test_no_audio_track_is_detected_from_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "audio.wav"
            fake = mock.Mock(
                returncode=1,
                stderr=b"Output file #0 does not contain any stream",
            )
            with mock.patch("app.audio.subprocess.run", return_value=fake):
                with self.assertRaises(RuntimeError) as ctx:
                    audio.extract_audio(Path("/media/silent.mp4"), out)
            self.assertIn("no audio track", str(ctx.exception))

    def test_success_but_empty_output_flags_missing_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "audio.wav"
            # ffmpeg "succeeds" but writes nothing -> treated as missing audio.
            fake = mock.Mock(returncode=0, stderr=b"")
            with mock.patch("app.audio.subprocess.run", return_value=fake):
                with self.assertRaises(RuntimeError) as ctx:
                    audio.extract_audio(Path("/media/silent.mp4"), out)
            self.assertIn("no audio", str(ctx.exception).lower())

    def test_success_with_output_returns_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "audio.wav"

            def fake_run(*args, **kwargs):
                out.write_bytes(b"RIFFfake-wav-data")
                return mock.Mock(returncode=0, stderr=b"")

            with mock.patch("app.audio.subprocess.run", side_effect=fake_run):
                result = audio.extract_audio(Path("/media/movie.mkv"), out)
            self.assertEqual(result, out)


if __name__ == "__main__":
    unittest.main()
