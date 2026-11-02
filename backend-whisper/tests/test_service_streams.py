"""A Windows service has no console, so sys.stdout and sys.stderr are None.

Model downloads report progress through tqdm bars, and tqdm writes to
sys.stderr: under the service every download failed at once with
"'NoneType' object has no attribute 'write'".
"""

import queue
import sys
import unittest
from unittest import mock

import run_server


class MissingStdStreamsTests(unittest.TestCase):
    def test_missing_streams_are_replaced_with_writable_ones(self):
        with mock.patch.object(sys, "stdout", None), mock.patch.object(sys, "stderr", None):
            run_server.ensure_std_streams()
            sys.stdout.write("status line\n")
            sys.stderr.write("progress bar\n")
            sys.stderr.flush()

    def test_existing_streams_are_kept(self):
        before = (sys.stdout, sys.stderr)
        run_server.ensure_std_streams()
        self.assertEqual((sys.stdout, sys.stderr), before)


class ProgressBarsWithoutAConsoleTests(unittest.TestCase):
    def test_download_progress_still_flows_when_stderr_is_none(self):
        try:
            import tqdm  # noqa: F401
        except ImportError:  # pragma: no cover - CI installs it with huggingface_hub
            self.skipTest("tqdm not installed")
        import app.model_manager as mm

        events: queue.Queue = queue.Queue()
        with mock.patch.object(sys, "stderr", None):
            bar_class = mm._make_progress_tqdm(events, expected_bytes=100)
            bar = bar_class(total=100, unit="B", desc="Downloading")
            bar.update(40)
            bar.close()
        self.assertEqual(events.get_nowait()["pct"], 40.0)


if __name__ == "__main__":
    unittest.main()
