"""The launchctl service control: the macOS counterpart of the tray's sc.exe
calls. A fake launchctl on PATH proves the exact command lines and the parsing
without touching the real launchd domain."""

import importlib.util
import os
import stat
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

_MODULE_PATH = Path(__file__).resolve().parents[1] / "packaging" / "macos" / "service_control.py"
_spec = importlib.util.spec_from_file_location("service_control", _MODULE_PATH)
service_control = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(service_control)

RUNNING = """\
com.subsmelt.whisper = {
	flags = 0
	state = running
	pid = 40833
}
"""
NOT_RUNNING = """\
com.subsmelt.whisper = {
	flags = 0
	state = not running
}
"""


class _FakeLaunchctl:
    def __init__(self, directory: Path, stdout: str = "", code: int = 0):
        self.calls = directory / "launchctl.log"
        self.stdout = stdout
        self.code = code
        script = '#!/bin/sh\necho "$*" >> "$LAUNCHCTL_LOG"\n'
        if self.stdout:
            script += f"cat <<'EOF'\n{self.stdout}\nEOF\n"
        script += f"exit {self.code}\n"
        self.path = directory / "launchctl"
        self.path.write_text(script, encoding="utf-8")
        self.path.chmod(self.path.stat().st_mode | stat.S_IXUSR)

    def recorded(self) -> list[str]:
        if not self.calls.exists():
            return []
        return self.calls.read_text(encoding="utf-8").strip().splitlines()


class ServiceControlTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.bin = Path(self._tmp.name)
        log = self.bin / "launchctl.log"
        self._patch = mock.patch.dict(
            os.environ,
            {"PATH": f"{self.bin}:{os.environ.get('PATH', '/usr/bin:/bin')}", "LAUNCHCTL_LOG": str(log)},
        )
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def test_start_runs_kickstart_on_the_user_domain(self):
        fake = _FakeLaunchctl(self.bin)

        code, _out = service_control.start_service()

        self.assertEqual((code, fake.recorded()), (0, [f"kickstart gui/{os.getuid()}/com.subsmelt.whisper"]))

    def test_stop_sends_sigterm(self):
        fake = _FakeLaunchctl(self.bin)

        code, _out = service_control.stop_service()

        self.assertEqual((code, fake.recorded()), (0, [f"kill SIGTERM gui/{os.getuid()}/com.subsmelt.whisper"]))

    def test_status_reads_the_state_line_of_a_running_agent(self):
        _fake = _FakeLaunchctl(self.bin, stdout=RUNNING)

        self.assertEqual(service_control.service_status(), "running")

    def test_a_loaded_but_idle_agent_reads_as_stopped(self):
        _fake = _FakeLaunchctl(self.bin, stdout=NOT_RUNNING)

        self.assertEqual(service_control.service_status(), "stopped")

    def test_an_unloaded_agent_reads_as_not_installed(self):
        _fake = _FakeLaunchctl(self.bin, stdout='Could not find service "com.subsmelt.whisper" in domain gui\n', code=3)

        self.assertEqual(service_control.service_status(), "not installed")


if __name__ == "__main__":
    unittest.main()
