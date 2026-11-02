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
    def __init__(self, directory: Path, stdout: str = "", code: int = 0, loaded: bool = True):
        self.calls = directory / "launchctl.log"
        self.stdout = stdout
        self.code = code
        script = '#!/bin/sh\necho "$*" >> "$LAUNCHCTL_LOG"\n'
        if not loaded:
            script += 'if [ "$1" = print ]; then echo "Could not find service" >&2; exit 113; fi\n'
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
            {
                "PATH": f"{self.bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
                "LAUNCHCTL_LOG": str(log),
                "HOME": str(self.bin),
            },
        )
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def _install_plist(self) -> Path:
        plist = self.bin / "Library" / "LaunchAgents" / "com.subsmelt.whisper.plist"
        plist.parent.mkdir(parents=True)
        plist.write_text("<plist/>", encoding="utf-8")
        return plist

    def test_start_kickstarts_a_loaded_agent(self):
        fake = _FakeLaunchctl(self.bin)
        target = f"gui/{os.getuid()}/com.subsmelt.whisper"

        code, _out = service_control.start_service()

        self.assertEqual((code, fake.recorded()), (0, [f"print {target}", f"kickstart {target}"]))

    def test_start_loads_a_stopped_agent_before_kickstarting_it(self):
        plist = self._install_plist()
        fake = _FakeLaunchctl(self.bin, loaded=False)
        domain = f"gui/{os.getuid()}"

        code, _out = service_control.start_service()

        self.assertEqual(
            (code, fake.recorded()),
            (
                0,
                [
                    f"print {domain}/com.subsmelt.whisper",
                    f"bootstrap {domain} {plist}",
                    f"kickstart {domain}/com.subsmelt.whisper",
                ],
            ),
        )

    def test_stop_unloads_the_agent_so_keepalive_cannot_restart_it(self):
        fake = _FakeLaunchctl(self.bin)

        code, _out = service_control.stop_service()

        self.assertEqual((code, fake.recorded()), (0, [f"bootout gui/{os.getuid()}/com.subsmelt.whisper"]))

    def test_a_stopped_agent_with_its_plist_installed_reads_as_stopped(self):
        self._install_plist()
        _fake = _FakeLaunchctl(self.bin, loaded=False)

        self.assertEqual(service_control.service_status(), "stopped")

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
