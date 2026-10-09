import subprocess
import unittest
from unittest import mock

from app import nemotron_runtime


class VersionProbeTests(unittest.TestCase):
    def setUp(self):
        nemotron_runtime._known_versions.clear()

    def test_a_failing_probe_is_none_and_is_retried_until_it_succeeds(self):
        # A binary that cannot start (missing driver, bad install) must not be
        # remembered as broken for the life of the process.
        argv = ["nemo-speech", "--version"]
        runs = [
            subprocess.CompletedProcess(argv, 1, stdout="", stderr="error: no CUDA driver\nnemo-speech 0.1.0\n"),
            subprocess.CompletedProcess(argv, 0, stdout="nemo-speech 0.1.0\n", stderr=""),
        ]
        with mock.patch.object(nemotron_runtime.subprocess, "run", side_effect=runs) as run:
            versions = [nemotron_runtime._version_of("/opt/nemo-speech") for _ in range(3)]
        self.assertEqual(versions, [None, "0.1.0", "0.1.0"])
        self.assertEqual(run.call_count, 2)


if __name__ == "__main__":
    unittest.main()
