"""Refresh and "Open health page" talk to the server that is running.

The form fields stay editable while the child runs, so a health call built from
them would hit a port nothing is bound to. The window records the settings the
child was launched with and uses those.

WhisperGuiApp needs a display to construct, so its methods are exercised on a
bare instance with the few attributes they read.
"""

import importlib.util
import unittest
from pathlib import Path
from unittest import mock

_MODULE_PATH = Path(__file__).resolve().parents[1] / "packaging" / "windows" / "tray" / "whisper_gui.py"
_spec = importlib.util.spec_from_file_location("whisper_gui", _MODULE_PATH)
whisper_gui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(whisper_gui)

RUNNING = ("0.0.0.0", "9000", "launched-token")
EDITED = ("127.0.0.1", "9999", "typed-token")


class _Var:
    def __init__(self, value: str) -> None:
        self._value = value

    def get(self) -> str:
        return self._value


class _Controller:
    def __init__(self, running: bool) -> None:
        self._running = running

    def running(self) -> bool:
        return self._running


def _window(running: bool, active: tuple[str, str, str] | None) -> "whisper_gui.WhisperGuiApp":
    app = whisper_gui.WhisperGuiApp.__new__(whisper_gui.WhisperGuiApp)
    app.ctl = _Controller(running)
    app.active = active
    app.host_var, app.port_var, app.token_var = (_Var(value) for value in EDITED)
    app.info_text: list[str] = []
    app._set_info = app.info_text.append
    # sc.exe/netstat are Windows-only; the service line has its own tests.
    app._refresh_service = lambda port=None: False
    return app


class HealthUrlTests(unittest.TestCase):
    def test_a_wide_bind_is_reached_over_loopback(self):
        self.assertEqual(whisper_gui.health_url("0.0.0.0", "9000"), "http://127.0.0.1:9000/health")

    def test_a_specific_host_is_used_as_is(self):
        self.assertEqual(whisper_gui.health_url("192.168.1.25", "8001"), "http://192.168.1.25:8001/health")


class RefreshTests(unittest.TestCase):
    def test_refresh_reads_the_running_servers_health(self):
        app = _window(running=True, active=RUNNING)
        with mock.patch.object(whisper_gui, "fetch_health", return_value={"capabilities": {}}) as fetch:
            app.on_refresh()
        self.assertEqual(fetch.call_args.args, RUNNING)
        self.assertIn("version:", app.info_text[-1])

    def test_refresh_falls_back_to_the_form_when_the_launch_is_unknown(self):
        app = _window(running=True, active=None)
        with mock.patch.object(whisper_gui, "fetch_health", return_value=None) as fetch:
            app.on_refresh()
        self.assertEqual(fetch.call_args.args, EDITED)

    def test_refresh_says_so_when_nothing_is_running(self):
        app = _window(running=False, active=None)
        with mock.patch.object(whisper_gui, "fetch_health") as fetch:
            app.on_refresh()
        fetch.assert_not_called()
        self.assertEqual(app.info_text, ["Server is not running."])


class OpenHealthTests(unittest.TestCase):
    def test_opens_the_running_servers_port(self):
        app = _window(running=True, active=RUNNING)
        with mock.patch.object(whisper_gui.webbrowser, "open") as browser:
            app.open_health()
        browser.assert_called_once_with("http://127.0.0.1:9000/health")

    def test_opens_the_form_port_when_nothing_was_launched(self):
        app = _window(running=False, active=None)
        with mock.patch.object(whisper_gui.webbrowser, "open") as browser:
            app.open_health()
        browser.assert_called_once_with("http://127.0.0.1:9999/health")


if __name__ == "__main__":
    unittest.main()
