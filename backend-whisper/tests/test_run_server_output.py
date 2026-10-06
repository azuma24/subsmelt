import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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
