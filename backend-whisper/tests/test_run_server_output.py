import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_server
from app import nemotron_runtime
from tests.nemotron_fixtures import can_exec_wrappers, write_fake_binary

ROOT = Path(__file__).resolve().parent.parent


class RedirectedOutputTests(unittest.TestCase):
    def test_check_survives_a_stdout_that_cannot_encode_the_status_arrow(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_file = str(Path(tmp) / "whisper-server.log")
            env = {**os.environ, "PYTHONIOENCODING": "cp1252", "SUBSMELT_WHISPER_LOG_FILE": log_file}
            result = subprocess.run(
                [sys.executable, "run_server.py", "--check"], cwd=ROOT, env=env, capture_output=True
            )
        self.assertEqual(result.returncode, 0, result.stderr.decode("cp1252", "replace"))
        self.assertIn(f"[run_server] file logging ? {log_file}".encode("cp1252"), result.stdout)


class MacosDefaultsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()

    def test_settings_live_in_application_support_and_logs_in_library_logs(self):
        with mock.patch.dict(os.environ, {"HOME": "/Users/op"}):
            self.assertEqual(
                run_server.default_data_dir(env={}, platform="darwin"),
                Path("/Users/op/Library/Application Support/SubSmelt"),
            )
            self.assertEqual(
                run_server.default_log_file(env={}, platform="darwin"),
                "/Users/op/Library/Logs/SubSmelt Whisper/whisper-server.log",
            )

    def test_the_frozen_app_uses_the_ffmpeg_bundled_beside_it(self):
        executable = self.tmp / "SubSmelt Whisper" / "whisper-server" / "whisper-server"
        env = {"SUBSMELT_WHISPER_CONFIG": str(self.tmp / "missing.json")}
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(sys, "platform", "darwin"),
            mock.patch.object(sys, "frozen", True, create=True),
            mock.patch.object(sys, "executable", str(executable)),
        ):
            bundled = run_server.load_config().ffmpeg
            os.environ["SUBSMELT_FFMPEG"] = "/opt/homebrew/bin/ffmpeg"
            explicit = run_server.load_config().ffmpeg
        self.assertEqual(bundled, f"{self.tmp}/SubSmelt Whisper/whisper-server/ffmpeg/ffmpeg")
        self.assertEqual(explicit, "/opt/homebrew/bin/ffmpeg")

    @unittest.skipUnless(can_exec_wrappers(), "needs a POSIX shell wrapper")
    def test_the_macos_startup_line_reports_nemo_speech_on_metal(self):
        nemotron_runtime._known_versions.clear()
        self.addCleanup(nemotron_runtime._known_versions.clear)
        binary = write_fake_binary(self.tmp)
        with mock.patch.dict(os.environ, {"SUBSMELT_NEMO_SPEECH": str(binary)}):
            gpu_ok, message = run_server.verify_accelerator(platform="darwin")
        self.assertTrue(gpu_ok)
        self.assertEqual(message, "nemo-speech 0.1.0 on Metal — Nemotron runs on the GPU; Whisper runs on the CPU.")
        self.assertNotIn("NVIDIA", message)
