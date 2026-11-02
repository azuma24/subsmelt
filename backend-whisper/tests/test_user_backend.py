"""Starting and stopping the per-user Windows backend without administrator rights.

The backend is a run_server.exe the signed-in user starts, detached from the
tray or window that started it. Any user may stop a process of their own, so
Stop finds the run_server.exe listening on the backend's port and ends it;
nothing needs UAC. Windows commands are replaced by a runner fed captured output.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

_TRAY = Path(__file__).resolve().parents[1] / "packaging" / "windows" / "tray"
sys.path.insert(0, str(_TRAY))
_spec = importlib.util.spec_from_file_location("user_backend", _TRAY / "user_backend.py")
user_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(user_backend)

NETSTAT = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:8001           0.0.0.0:0              LISTENING       4321
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       999
"""


class FakeWindows:
    """netstat, tasklist and taskkill against a table of running processes."""

    def __init__(self, processes: dict[int, str], netstat: str = NETSTAT) -> None:
        self.processes = dict(processes)
        self.netstat = netstat
        self.calls: list[list[str]] = []

    def __call__(self, cmd: list[str]) -> tuple[int, str]:
        self.calls.append(cmd)
        if cmd[0] == "netstat.exe":
            alive = "\n".join(
                line
                for line in self.netstat.splitlines()
                if not line.strip().endswith(tuple(f" {p}" for p in self._gone()))
            )
            return 0, alive
        if cmd[0] == "tasklist.exe":
            pid = int(cmd[2].split()[-1])
            name = self.processes.get(pid)
            return 0, f'"{name}","{pid}","Console","1","120,000 K"\n' if name else "INFO: No tasks are running.\n"
        if cmd[0] == "taskkill.exe":
            pid = int(cmd[cmd.index("/PID") + 1])
            self.processes.pop(pid, None)
            return 0, "SUCCESS"
        raise AssertionError(cmd)

    def _gone(self) -> list[int]:
        return [pid for pid in (4321, 999) if pid not in self.processes]


class FindBackendTests(unittest.TestCase):
    def test_the_backend_is_the_run_server_listening_on_the_port(self):
        windows = FakeWindows({4321: "run_server.exe", 999: "node.exe"})
        self.assertEqual(user_backend.backend_pid("8001", runner=windows), 4321)

    def test_another_program_on_the_port_is_not_the_backend(self):
        windows = FakeWindows({4321: "python.exe"})
        self.assertIsNone(user_backend.backend_pid("8001", runner=windows))

    def test_nothing_listening_means_stopped(self):
        self.assertIsNone(user_backend.backend_pid("8123", runner=FakeWindows({})))


class StopTests(unittest.TestCase):
    def test_stop_ends_the_backend_without_elevation(self):
        windows = FakeWindows({4321: "run_server.exe"})
        self.assertEqual(user_backend.stop_backend("8001", runner=windows, wait_seconds=1), "stopped")
        kill = next(cmd for cmd in windows.calls if cmd[0] == "taskkill.exe")
        self.assertEqual(kill, ["taskkill.exe", "/PID", "4321", "/T", "/F"])
        self.assertNotIn("RunAs", " ".join(" ".join(cmd) for cmd in windows.calls))

    def test_stop_leaves_other_programs_on_the_port_alone(self):
        windows = FakeWindows({4321: "python.exe"})
        self.assertEqual(user_backend.stop_backend("8001", runner=windows, wait_seconds=1), "not running")
        self.assertFalse(any(cmd[0] == "taskkill.exe" for cmd in windows.calls))


class StartTests(unittest.TestCase):
    def test_start_launches_a_detached_windowless_process(self):
        launched = {}

        def popen(command, **kwargs):
            launched.update(command=command, **kwargs)

        user_backend.start_backend(["C:/app/run_server.exe"], popen=popen)
        self.assertEqual(launched["command"], ["C:/app/run_server.exe"])
        flags = launched["creationflags"]
        self.assertTrue(flags & user_backend.CREATE_NO_WINDOW)
        self.assertTrue(flags & user_backend.CREATE_NEW_PROCESS_GROUP)
        self.assertTrue(launched["close_fds"])


class _Proc:
    def __init__(self, exit_code=None):
        self.exit_code = exit_code
        self.pid = 0
        self.windows = None

    def poll(self):
        if self.windows is not None and self.pid and self.pid not in self.windows.processes:
            return 1
        return self.exit_code

    def wait(self, timeout=None):
        if self.exit_code is None:
            import subprocess

            raise subprocess.TimeoutExpired("run_server.exe", timeout)
        return self.exit_code


class ControllerTests(unittest.TestCase):
    def controller(self, windows, proc):
        proc.windows = windows
        return user_backend.UserBackendController(
            command_of=lambda: ["run_server.exe"],
            log_file_of=lambda: Path("whisper-server.log"),
            runner=windows,
            popen=lambda command, **kwargs: proc,
        )

    def test_a_backend_still_starting_counts_as_running(self):
        controller = self.controller(FakeWindows({}, netstat=""), _Proc())
        self.assertEqual(controller.start("0.0.0.0", "8001", "k"), "started on http://0.0.0.0:8001")
        self.assertTrue(controller.running())

    def test_a_backend_that_dies_at_once_is_reported(self):
        controller = self.controller(FakeWindows({}, netstat=""), _Proc(exit_code=1))
        self.assertIn("exited immediately", controller.start("0.0.0.0", "8001", "k"))
        self.assertFalse(controller.running())

    def test_stop_ends_a_backend_still_starting_up(self):
        # Probing CUDA, it has no port yet: only the handle this window holds finds it.
        proc = _Proc()
        windows = FakeWindows({}, netstat="")
        controller = self.controller(windows, proc)
        controller.start("0.0.0.0", "8001", "k")
        proc.pid = 777
        windows.processes[777] = "run_server.exe"
        self.assertEqual(controller.stop(), "stopped")
        self.assertNotIn(777, windows.processes)
        self.assertFalse(controller.running())

    def test_stop_finds_the_backend_on_whatever_port_it_holds(self):
        # The port was just changed in settings; the running backend still holds the old one.
        windows = FakeWindows({4321: "run_server.exe"})
        controller = self.controller(windows, _Proc())
        self.assertTrue(controller.running())
        self.assertEqual(controller.stop(), "stopped")
        self.assertNotIn(4321, windows.processes)


if __name__ == "__main__":
    unittest.main()
