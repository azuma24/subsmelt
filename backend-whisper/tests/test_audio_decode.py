"""faster-whisper decodes audio through PyAV; an unpinned PyAV release broke it."""

import struct
import tempfile
import unittest
import wave
from pathlib import Path

try:
    from faster_whisper.audio import decode_audio
except ModuleNotFoundError as exc:  # pragma: no cover - optional dependency
    decode_audio = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


@unittest.skipIf(decode_audio is None, f"faster-whisper unavailable: {IMPORT_ERROR}")
class DecodeAudioTests(unittest.TestCase):
    def test_a_one_second_16khz_wav_decodes_to_16000_samples(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "silence.wav"
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(struct.pack("<16000h", *([0] * 16000)))
            self.assertEqual(len(decode_audio(str(path))), 16000)
