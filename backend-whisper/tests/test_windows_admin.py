"""Installed-service detection, UAC elevation and config opening for the
Windows control apps.

windows_admin.py lives under packaging/windows/tray/ (frozen into the GUI and
tray exes), so it is loaded here by path. sc.exe, netstat and PowerShell are
replaced by a recording runner fed captured Windows output.
"""

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_MODULE_PATH = Path(__file__).resolve().parents[1] / "packaging" / "windows" / "tray" / "windows_admin.py"
_spec = importlib.util.spec_from_file_location("windows_admin", _MODULE_PATH)
windows_admin = importlib.util.module_from_spec(_spec)
# dataclasses resolves annotations through sys.modules, so register first.
sys.modules["windows_admin"] = windows_admin
_spec.loader.exec_module(windows_admin)

SC_RUNNING = """
SERVICE_NAME: SubSmeltWhisper
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : 4321
        FLAGS              :
"""

SC_STOPPED = SC_RUNNING.replace("4  RUNNING", "1  STOPPED").replace("4321", "0")

NETSTAT = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100
  TCP    0.0.0.0:8001           0.0.0.0:0              LISTENING       4321
  TCP    127.0.0.1:8001         127.0.0.1:50122        ESTABLISHED     9999
  TCP    0.0.0.0:18001          0.0.0.0:0              LISTENING       7777
  TCP    [::]:9001              [::]:0                 LISTENING       5555
  UDP    0.0.0.0:8001           *:*                                    2222
"""


class Runner:
    """Stands in for subprocess: answers each command from a table."""

    def __init__(self, answers: dict[str, tuple[int, str]]) -> None:
        self.answers = answers
        self.calls: list[list[str]] = []

    def __call__(self, cmd: list[str]) -> tuple[int, str]:
        self.calls.append(cmd)
        return self.answers.get(cmd[0], (0, ""))


@mock.patch.object(windows_admin, "is_windows", return_value=True)
class ServicePortTests(unittest.TestCase):
    def test_reads_state_and_pid_from_sc(self, _windows):
        self.assertEqual(windows_admin.parse_service_status(SC_RUNNING), windows_admin.ServiceStatus("running", 4321))
        self.assertEqual(windows_admin.parse_service_status(SC_STOPPED), windows_admin.ServiceStatus("stopped", None))

    def test_a_missing_service_is_not_installed(self, _windows):
        runner = Runner({"sc.exe": (1060, "[SC] OpenService FAILED 1060:")})
        status = windows_admin.query_service(runner)
        self.assertEqual(status.state, "not installed")
        self.assertFalse(status.installed)

    def test_listeners_are_matched_on_the_exact_port(self, _windows):
        self.assertEqual(windows_admin.listening_pids(NETSTAT, "8001"), {4321})
        self.assertEqual(windows_admin.listening_pids(NETSTAT, "9001"), {5555})
        self.assertEqual(windows_admin.listening_pids(NETSTAT, "8002"), set())

    def test_the_running_service_owns_the_port_it_listens_on(self, _windows):
        runner = Runner({"sc.exe": (0, SC_RUNNING), "netstat.exe": (0, NETSTAT)})
        status = windows_admin.query_service(runner)
        self.assertTrue(windows_admin.service_owns_port(status, "8001", runner))
        # Something else on 9001 is not the service.
        self.assertFalse(windows_admin.service_owns_port(status, "9001", runner))

    def test_a_stopped_service_owns_nothing(self, _windows):
        runner = Runner({"sc.exe": (0, SC_STOPPED), "netstat.exe": (0, NETSTAT)})
        status = windows_admin.query_service(runner)
        self.assertFalse(windows_admin.service_owns_port(status, "8001", runner))
        self.assertNotIn(["netstat.exe", "-ano"], runner.calls)

    def test_off_windows_there_is_no_service(self, windows):
        windows.return_value = False
        runner = Runner({})
        self.assertEqual(windows_admin.query_service(runner).state, "unavailable")
        self.assertEqual(runner.calls, [])


class ElevationTests(unittest.TestCase):
    def test_the_command_asks_for_uac_and_quotes_arguments(self):
        cmd = windows_admin.elevated_command("notepad.exe", ['"C:\\Data\\it\'s\\config.json"'], wait=False)
        script = cmd[-1]
        self.assertEqual(cmd[0], "powershell.exe")
        self.assertIn("-Verb RunAs", script)
        self.assertIn("'\"C:\\Data\\it''s\\config.json\"'", script)
        self.assertIn(f"exit {windows_admin.ERROR_CANCELLED}", script)
        self.assertNotIn("-Wait", script)

    def test_a_declined_prompt_is_its_own_error(self):
        with self.assertRaises(windows_admin.ElevationDeclined):
            windows_admin.run_elevated("sc.exe", ["stop"], wait=True, runner=Runner({"powershell.exe": (1223, "")}))

    def test_other_failures_carry_the_reason(self):
        runner = Runner({"powershell.exe": (1, "Start-Process : This command cannot be run.")})
        with self.assertRaises(windows_admin.ElevatedActionFailed) as caught:
            windows_admin.run_elevated("sc.exe", ["stop"], wait=True, runner=runner)
        self.assertIn("This command cannot be run", str(caught.exception))

    def test_service_control_runs_the_matching_cmdlet_elevated(self):
        runner = Runner({})
        windows_admin.control_service("restart", runner)
        script = runner.calls[0][-1]
        self.assertIn("-Verb RunAs", script)
        self.assertIn("Restart-Service -Name ''SubSmeltWhisper''", script)

    def test_service_messages(self):
        self.assertIn("restarted", windows_admin.service_action_message("restart", None))
        declined = windows_admin.service_action_message("stop", windows_admin.ElevationDeclined())
        self.assertIn("administrator approval was declined", declined)
        failed = windows_admin.service_action_message("start", windows_admin.ElevatedActionFailed("exit code 2"))
        self.assertIn("Start service failed: exit code 2", failed)


class OpenConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "SubSmelt" / "config.json"
        self.opened: list[Path] = []

    def test_a_writable_config_opens_normally_without_elevation(self):
        runner = Runner({})
        self.assertIsNone(windows_admin.open_config(self.path, self.opened.append, runner))
        self.assertEqual(self.opened, [self.path])
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{}\n")
        self.assertEqual(runner.calls, [])

    def test_an_existing_config_is_not_overwritten(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text('{"token": "s3cr3t"}', encoding="utf-8")
        windows_admin.open_config(self.path, self.opened.append, Runner({}))
        self.assertEqual(self.path.read_text(encoding="utf-8"), '{"token": "s3cr3t"}')

    def test_a_handler_failure_is_reported(self):
        def broken(_path: Path) -> None:
            raise OSError("no application is associated")

        error = windows_admin.open_config(self.path, broken, Runner({}))
        self.assertIn("no application is associated", error)

    @mock.patch.object(windows_admin, "is_windows", return_value=True)
    @mock.patch.object(windows_admin, "_editable_here", side_effect=PermissionError(13, "denied"))
    def test_the_protected_config_opens_in_an_elevated_editor(self, _editable, _windows):
        runner = Runner({})
        self.assertIsNone(windows_admin.open_config(self.path, self.opened.append, runner))
        self.assertEqual(self.opened, [])
        script = runner.calls[0][-1]
        self.assertIn("'notepad.exe'", script)
        self.assertIn("-Verb RunAs", script)
        self.assertIn(str(self.path), script)

    @mock.patch.object(windows_admin, "is_windows", return_value=True)
    @mock.patch.object(windows_admin, "_editable_here", side_effect=PermissionError(13, "denied"))
    def test_a_declined_prompt_is_reported(self, _editable, _windows):
        error = windows_admin.open_config(self.path, self.opened.append, Runner({"powershell.exe": (1223, "")}))
        self.assertIn("administrator approval was declined", error)

    @mock.patch.object(windows_admin, "is_windows", return_value=True)
    @mock.patch.object(windows_admin, "_editable_here", side_effect=PermissionError(13, "denied"))
    def test_an_elevation_failure_is_reported(self, _editable, _windows):
        runner = Runner({"powershell.exe": (1, "Start-Process : notepad.exe was not found")})
        error = windows_admin.open_config(self.path, self.opened.append, runner)
        self.assertIn("notepad.exe was not found", error)


if __name__ == "__main__":
    unittest.main()
