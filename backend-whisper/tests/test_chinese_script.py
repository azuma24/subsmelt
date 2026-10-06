"""Chinese transcripts are converted to the script the user prefers."""

import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import app.transcribe as transcribe
from app.chinese_script import convert_segments
from app.schemas import TranscribeRequest, TranscribeResponse, UploadTranscribeResponse


def _copy_instead_of_ffmpeg(src: Path, dst: Path, is_cancelled=None) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, dst)
    return dst


def _runner_saying(text: str, language: str):
    def runner(request, audio_path, is_cancelled, min_progress_interval):
        yield {"type": "progress", "processedSeconds": 1.0, "totalSeconds": 1.0, "pct": 100.0}
        return [SimpleNamespace(start=0.0, end=1.0, text=text)], SimpleNamespace(language=language, duration=1.0)

    return runner


class ConvertSegmentsTests(unittest.TestCase):
    def test_taiwan_script_uses_taiwan_phrases(self):
        [converted] = convert_segments([SimpleNamespace(start=1.0, end=2.0, text="我们的软件和视频")], "zh-TW")
        self.assertEqual((converted.start, converted.end, converted.text), (1.0, 2.0, "我們的軟體和影片"))

    def test_taiwan_script_leaves_traditional_text_traditional(self):
        [converted] = convert_segments([SimpleNamespace(start=0.0, end=1.0, text="我們的網路")], "zh-TW")
        self.assertEqual(converted.text, "我們的網路")

    def test_mainland_script_converts_traditional_to_simplified(self):
        [converted] = convert_segments([SimpleNamespace(start=0.0, end=1.0, text="簡體中文與繁體")], "zh-CN")
        self.assertEqual(converted.text, "简体中文与繁体")

    def test_speaker_survives_conversion(self):
        [converted] = convert_segments(
            [SimpleNamespace(start=0.0, end=1.0, text="视频", speaker="SPEAKER_01")], "zh-TW"
        )
        self.assertEqual(converted.speaker, "SPEAKER_01")


class PipelineConversionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.media = Path(self._tmp.name)
        (self.media / "clip.mkv").write_bytes(b"x")
        self._extract = mock.patch.object(transcribe, "extract_audio", _copy_instead_of_ffmpeg)
        self._extract.start()

    def tearDown(self):
        self._extract.stop()
        self._tmp.cleanup()

    def _run(self, text, detected, deliver="content", **request):
        request.setdefault("output_format", "txt")
        with mock.patch.dict(transcribe.ENGINE_RUNNERS, {"whisper": _runner_saying(text, detected)}):
            return transcribe.run_transcription(
                TranscribeRequest(input_path=str(self.media / "clip.mkv"), model="small", **request),
                self.media / "clip.mkv",
                deliver=deliver,
            )

    def test_requested_chinese_is_converted_in_upload_mode(self):
        result = self._run("我们的软件", "zh", language="zh", chinese_script="zh-TW")
        self.assertEqual(result["content"], "我們的軟體\n")
        self.assertEqual(result["chinese_script"], "zh-TW")
        self.assertEqual(UploadTranscribeResponse(**result).chinese_script, "zh-TW")

    def test_detected_chinese_is_converted_in_shared_mode(self):
        result = self._run("軟體與影片", "zh", deliver="path", language="auto", chinese_script="zh-CN")
        self.assertEqual(Path(result["subtitle_path"]).read_text(encoding="utf-8"), "软体与影片\n")
        self.assertEqual(result["chinese_script"], "zh-CN")
        self.assertEqual(TranscribeResponse(**result).chinese_script, "zh-CN")

    def test_three_letter_chinese_code_counts_as_chinese(self):
        result = self._run("视频", "zh", language="chi", chinese_script="zh-TW")
        self.assertEqual(result["content"], "影片\n")

    def test_non_chinese_transcripts_are_left_alone(self):
        # Japanese shares Han characters; converting them would corrupt it.
        result = self._run("会议软件", "ja", language="ja", chinese_script="zh-TW")
        self.assertEqual(result["content"], "会议软件\n")
        self.assertIsNone(result["chinese_script"])

    def test_no_preference_means_no_conversion(self):
        result = self._run("我们的软件", "zh", language="zh")
        self.assertEqual(result["content"], "我们的软件\n")
        self.assertIsNone(result["chinese_script"])

    def test_unknown_script_is_rejected_by_the_schema(self):
        with self.assertRaises(ValueError):
            TranscribeRequest(input_path="/x.mkv", chinese_script="zh-HK")


if __name__ == "__main__":
    unittest.main()
