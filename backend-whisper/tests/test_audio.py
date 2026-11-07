import shutil
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

from app import audio
from app.engine import TranscriptionCancelled


class FakeFfmpeg:
    """Stands in for ``subprocess.Popen``: stays running for ``polls`` waits,
    then exits with ``returncode`` (after ``on_exit``, e.g. writing output)."""

    def __init__(self, returncode=0, stderr=b"", polls=0, on_exit=None):
        self.returncode = None
        self._exit_code = returncode
        self._stderr = stderr
        self._polls = polls
        self._on_exit = on_exit
        self.killed = False

    def __call__(self, *args, **kwargs):
        return self

    def communicate(self, timeout=None):
        if self.killed:
            self.returncode = -9
            return b"", b""
        if self._polls > 0:
            self._polls -= 1
            raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=timeout)
        if self._on_exit:
            self._on_exit()
        self.returncode = self._exit_code
        return b"", self._stderr

    def kill(self):
        self.killed = True


class ExtractAudioRobustnessTests(unittest.TestCase):
    def _extract(self, fake, out, **kwargs):
        with mock.patch("app.audio.subprocess.Popen", fake), mock.patch.object(audio, "CANCEL_POLL_SECONDS", 0.01):
            return audio.extract_audio(Path("/media/movie.mkv"), out, **kwargs)

    def test_timeout_kills_ffmpeg_and_raises_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeFfmpeg(polls=10_000)
            with self.assertRaises(RuntimeError) as ctx:
                self._extract(fake, Path(tmp) / "audio.wav", timeout_seconds=0)
            self.assertIn("timed out", str(ctx.exception))
            self.assertTrue(fake.killed)

    def test_cancellation_kills_ffmpeg_while_it_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeFfmpeg(polls=10_000)
            with self.assertRaises(TranscriptionCancelled):
                self._extract(fake, Path(tmp) / "audio.wav", is_cancelled=lambda: True)
            self.assertTrue(fake.killed)

    def test_nonzero_exit_includes_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError) as ctx:
                self._extract(FakeFfmpeg(returncode=1, stderr=b"some opaque ffmpeg failure"), Path(tmp) / "a.wav")
            message = str(ctx.exception)
            self.assertIn("exit code 1", message)
            self.assertIn("some opaque ffmpeg failure", message)

    def test_no_audio_track_is_detected_from_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeFfmpeg(returncode=1, stderr=b"Output file #0 does not contain any stream")
            with self.assertRaises(RuntimeError) as ctx:
                self._extract(fake, Path(tmp) / "a.wav")
            self.assertIn("no audio track", str(ctx.exception))

    def test_success_but_empty_output_flags_missing_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            # ffmpeg "succeeds" but writes nothing -> treated as missing audio.
            with self.assertRaises(RuntimeError) as ctx:
                self._extract(FakeFfmpeg(returncode=0), Path(tmp) / "a.wav")
            self.assertIn("no audio", str(ctx.exception).lower())

    def test_success_with_output_returns_path_after_polling(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "audio.wav"
            fake = FakeFfmpeg(polls=3, on_exit=lambda: out.write_bytes(b"RIFFfake-wav-data"))
            result = self._extract(fake, out, is_cancelled=lambda: False)
            self.assertEqual(result, out)
            self.assertFalse(fake.killed)


@unittest.skipUnless(shutil.which(audio.ffmpeg_binary()), "ffmpeg not installed")
class LocalMediaInputTests(unittest.TestCase):
    def test_probe_uses_the_file_contents_for_standalone_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "sound.unknown"
            with wave.open(str(source), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(bytes(3200))
            result = audio.extract_audio(source, Path(tmp) / "result.wav")
            with wave.open(str(result), "rb") as wav:
                self.assertEqual((wav.getframerate(), wav.getnframes()), (16000, 1600))

    def test_playlist_formats_are_rejected_even_with_a_media_extension(self):
        manifests = (
            "ffconcat version 1.0\nfile 'unavailable.wav'\n",
            "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nunavailable.wav\n#EXT-X-ENDLIST\n",
        )
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "clip.mkv"
            output = Path(tmp) / "result.wav"
            for manifest in manifests:
                with self.subTest(manifest=manifest.splitlines()[0]):
                    source.write_text(manifest, encoding="utf-8")
                    with self.assertRaisesRegex(RuntimeError, "ffmpeg failed"):
                        audio.extract_audio(source, output)
                    self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
