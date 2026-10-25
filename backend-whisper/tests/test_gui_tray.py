"""The system-tray controller's config, port, diagnostics and error surfacing.

whisper_tray.py lives under packaging/windows/tray/ and imports pystray behind
a guard, so it loads headless; the menu callbacks are exercised directly with a
fake icon standing in for pystray's.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_MODULE_PATH = Path(__file__).resolve().parents[1] / "packaging" / "windows" / "tray" / "whisper_tray.py"
_spec = importlib.util.spec_from_file_location("whisper_tray", _MODULE_PATH)
whisper_tray = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(whisper_tray)

ENV_KEYS = (
    "SUBSMELT_WHISPER_CONFIG",
    "SUBSMELT_WHISPER_PORT",
    "SUBSMELT_DATA_DIR",
    "SUBSMELT_WHISPER_SERVER_EXE",
)


class FakeIcon:
    """What a tray callback can reach: pystray.Icon.notify and .title."""

    def __init__(self) -> None:
        self.notifications: list[tuple[str, str]] = []
        self.title = ""

    def notify(self, message: str, title: str) -> None:
        self.notifications.append((message, title))


class TrayTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self._saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        self.addCleanup(self._restore_env)
        self.config = self.dir / "elsewhere" / "config.json"
        os.environ["SUBSMELT_WHISPER_CONFIG"] = str(self.config)

    def _restore_env(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


class OpenConfigTests(TrayTestCase):
    def test_opens_the_file_the_server_reads(self):
        # SUBSMELT_WHISPER_CONFIG is where run_server looks; the tray used to
        # open <data dir>/config.json regardless and edit a file nobody read.
        os.environ["SUBSMELT_DATA_DIR"] = str(self.dir / "data")
        with mock.patch.object(whisper_tray, "_open_with_handler") as opened:
            whisper_tray.open_config()
        self.assertEqual(opened.call_args.args[0], self.config)
        self.assertEqual(self.config.read_text(encoding="utf-8"), "{}\n")

    def test_a_failure_to_open_is_reported_not_swallowed(self):
        icon = FakeIcon()
        with mock.patch.object(whisper_tray, "_open_with_handler", side_effect=OSError("no handler")):
            whisper_tray.open_config(icon)
        self.assertEqual(len(icon.notifications), 1)
        self.assertIn("no handler", icon.notifications[0][0])

    def test_a_declined_uac_prompt_is_reported(self):
        icon = FakeIcon()
        with (
            mock.patch.object(whisper_tray.windows_admin, "_editable_here", side_effect=PermissionError()),
            mock.patch.object(whisper_tray.windows_admin, "is_windows", return_value=True),
            mock.patch.object(whisper_tray.windows_admin, "run", return_value=(1223, "")),
        ):
            whisper_tray.open_config(icon)
        self.assertIn("administrator approval was declined", icon.notifications[0][0])


class OpenHealthTests(TrayTestCase):
    def _open_health(self) -> str:
        with mock.patch.object(whisper_tray.webbrowser, "open") as browser:
            whisper_tray.open_health()
        return browser.call_args.args[0]

    def test_uses_the_port_from_config_json(self):
        self.config.parent.mkdir(parents=True)
        self.config.write_text(json.dumps({"port": 9000}), encoding="utf-8")
        self.assertEqual(self._open_health(), "http://127.0.0.1:9000/health")

    def test_env_port_wins_over_config_json(self):
        self.config.parent.mkdir(parents=True)
        self.config.write_text(json.dumps({"port": 9000}), encoding="utf-8")
        os.environ["SUBSMELT_WHISPER_PORT"] = "9100"
        self.assertEqual(self._open_health(), "http://127.0.0.1:9100/health")

    def test_falls_back_to_the_default_port(self):
        self.assertEqual(self._open_health(), "http://127.0.0.1:8001/health")


class DiagnosticsTests(TrayTestCase):
    def test_frozen_build_runs_the_bundled_server_check(self):
        # sys.executable is whisper-tray.exe itself when frozen, so the old
        # `-m app.provision` fallback re-launched the tray instead of a doctor.
        server_exe = self.dir / "run_server.exe"
        server_exe.write_text("", encoding="utf-8")
        os.environ["SUBSMELT_WHISPER_SERVER_EXE"] = str(server_exe)
        icon = FakeIcon()
        with (
            mock.patch.object(sys, "frozen", True, create=True),
            mock.patch.object(whisper_tray, "_run", return_value=(0, "CUDA runtime OK")) as run,
        ):
            whisper_tray.run_diagnostics(icon)
        self.assertEqual(run.call_args.args[0], [str(server_exe), "--check"])
        self.assertEqual(len(icon.notifications), 1)
        self.assertIn("CUDA runtime OK", icon.notifications[0][0])

    def test_a_failed_check_is_reported_as_a_failure(self):
        icon = FakeIcon()
        with (
            mock.patch.object(whisper_tray, "_diagnostics_command", return_value=["doctor"]),
            mock.patch.object(whisper_tray, "_run", return_value=(1, "first line\ncudnn_ops64_9.dll not found")),
        ):
            whisper_tray.run_diagnostics(icon)
        ((message, _title),) = icon.notifications
        self.assertIn("failed", message)
        self.assertIn("cudnn_ops64_9.dll not found", message)


class FailureSurfacingTests(TrayTestCase):
    def test_a_missing_server_executable_is_shown_on_the_icon(self):
        # The windowed exe has no console: a print is the same as silence.
        icon = FakeIcon()
        error = whisper_tray.ServerExecutableNotFound([self.dir / "run_server.exe"])
        with mock.patch.object(whisper_tray, "_server_command", side_effect=error):
            whisper_tray.start_server_process(icon)
        self.assertEqual(len(icon.notifications), 1)
        self.assertIn("run_server executable not found", icon.notifications[0][0])
        self.assertFalse(whisper_tray.server_process_running())

    def test_reporting_without_an_icon_does_not_raise(self):
        # --diagnostics and the dev console run the callbacks with no icon.
        whisper_tray._report(None, "nothing to show it on")


class ServiceControlTests(TrayTestCase):
    """The tray runs unelevated; service control needs an administrator."""

    def _service_action(self, action, result):
        icon = FakeIcon()
        with (
            mock.patch.object(whisper_tray, "_is_windows", return_value=True),
            mock.patch.object(whisper_tray.windows_admin, "run", return_value=result) as run,
        ):
            action(icon)
        return run.call_args.args[0], icon

    def test_start_runs_the_service_cmdlet_through_an_elevation_prompt(self):
        cmd, icon = self._service_action(whisper_tray.start_service, (0, ""))
        self.assertEqual(cmd[0], "powershell.exe")
        self.assertIn("-Verb RunAs", cmd[-1])
        self.assertIn("Start-Service -Name ''SubSmeltWhisper''", cmd[-1])
        self.assertIn("started", icon.notifications[0][0])

    def test_stop_runs_the_service_cmdlet_through_an_elevation_prompt(self):
        cmd, _icon = self._service_action(whisper_tray.stop_service, (0, ""))
        self.assertIn("Stop-Service -Name ''SubSmeltWhisper''", cmd[-1])

    def test_a_declined_prompt_is_reported(self):
        _cmd, icon = self._service_action(whisper_tray.start_service, (1223, ""))
        ((message, _title),) = icon.notifications
        self.assertIn("Start service cancelled", message)
        self.assertIn("administrator approval was declined", message)

    def test_a_failed_action_is_reported_with_its_reason(self):
        _cmd, icon = self._service_action(whisper_tray.stop_service, (1, "Stop-Service : Cannot stop service"))
        self.assertIn("Stop service failed", icon.notifications[0][0])
        self.assertIn("Cannot stop service", icon.notifications[0][0])


class DevServerScriptTests(unittest.TestCase):
    def test_a_shallow_frozen_path_does_not_break_import(self):
        # A onefile exe extracts to %TEMP%; with a shallow TEMP, parents[3] of
        # the extracted script raised IndexError at import and the tray never
        # started. The lookup must stay lazy and must tolerate that layout.
        with mock.patch.object(sys, "frozen", True, create=True):
            self.assertIsNone(whisper_tray.dev_server_script("/t/whisper_tray.py"))


if __name__ == "__main__":
    unittest.main()
