"""Start-failure detection in the Whisper control window.

Popen returning only means the process was created. A server that cannot bind —
the usual case being the installed service already holding the port — exits a
moment later, and the window used to report "started" about a process that was
already gone.

whisper_gui.py imports tkinter behind a guard, so it loads headless; only
ServerController is exercised here.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

_MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "packaging" / "windows" / "tray" / "whisper_gui.py"
)
_spec = importlib.util.spec_from_file_location("whisper_gui", _MODULE_PATH)
whisper_gui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(whisper_gui)


class StartFailureTests(unittest.TestCase):
    def _controller(self, command: list[str]) -> "whisper_gui.ServerController":
        controller = whisper_gui.ServerController()
        controller._command = staticmethod(lambda: command)  # type: ignore[method-assign]
        # Keep the grace period short; the production value is 2s.
        controller.STARTUP_GRACE_SECONDS = 0.5  # type: ignore[misc]
        return controller

    def test_a_server_that_exits_immediately_is_reported_as_failed(self):
        controller = self._controller([sys.executable, "-c", "raise SystemExit(3)"])

        message = controller.start("0.0.0.0", "8001", "")

        self.assertIn("failed to start", message)
        self.assertIn("exited immediately", message)
        self.assertIn("code 3", message)
        # The port hint is the actionable part: this is almost always a conflict
        # with the installed service.
        self.assertIn("8001", message)
        self.assertFalse(controller.running())

    def test_a_server_that_keeps_running_is_reported_as_started(self):
        controller = self._controller([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            message = controller.start("0.0.0.0", "8001", "")
            self.assertIn("started on http://0.0.0.0:8001", message)
            self.assertTrue(controller.running())
        finally:
            controller.stop()

    def test_starting_twice_does_not_spawn_a_second_process(self):
        controller = self._controller([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            controller.start("0.0.0.0", "8001", "")
            first = controller._proc
            self.assertEqual(controller.start("0.0.0.0", "8001", ""), "already running")
            self.assertIs(controller._proc, first)
        finally:
            controller.stop()

    def test_stop_is_safe_when_nothing_is_running(self):
        controller = self._controller([sys.executable, "-c", "pass"])
        self.assertEqual(controller.stop(), "not running")


if __name__ == "__main__":
    unittest.main()
