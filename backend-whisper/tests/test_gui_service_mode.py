"""The control window drives the installed service instead of a second server.

Setup registers the backend as the SubSmeltWhisper service on the chosen port.
The window's Start used to launch a separate run_server child into that same
port, which could never bind: the port looked "locked by the installation".
With the service installed, Start / Stop / Restart act on the service and the
status line reports it.
"""

import importlib.util
import unittest
from pathlib import Path
from unittest import mock

_MODULE_PATH = Path(__file__).resolve().parents[1] / "packaging" / "windows" / "tray" / "whisper_gui.py"
_spec = importlib.util.spec_from_file_location("whisper_gui", _MODULE_PATH)
whisper_gui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(whisper_gui)
ServiceStatus = whisper_gui.windows_admin.ServiceStatus


class DrivesServiceTests(unittest.TestCase):
    def test_an_installed_service_is_what_the_buttons_control(self):
        for state in ("running", "stopped", "starting", "stopping", "unknown"):
            self.assertTrue(whisper_gui.drives_service(ServiceStatus(state)), state)

    def test_without_a_service_the_window_runs_its_own_server(self):
        self.assertFalse(whisper_gui.drives_service(ServiceStatus("not installed")))
        self.assertFalse(whisper_gui.drives_service(ServiceStatus("unavailable")))


class ServiceStatusLabelTests(unittest.TestCase):
    def test_a_running_service_shows_its_port(self):
        self.assertEqual(
            whisper_gui.service_status_label(ServiceStatus("running", 1234), "8001"),
            "● Running as a service on port 8001",
        )

    def test_a_running_service_on_another_port_does_not_claim_this_one(self):
        # The port comes from the listener check; without it, no port is named.
        self.assertEqual(
            whisper_gui.service_status_label(ServiceStatus("running", 1234), None),
            "● Running as a service",
        )

    def test_a_stopped_service_reads_as_stopped(self):
        self.assertEqual(whisper_gui.service_status_label(ServiceStatus("stopped"), "8001"), "○ Stopped (service)")

    def test_transitions_are_named(self):
        self.assertEqual(whisper_gui.service_status_label(ServiceStatus("starting"), "8001"), "◐ Service starting…")
        self.assertEqual(whisper_gui.service_status_label(ServiceStatus("stopping"), "8001"), "◐ Service stopping…")


class _Var:
    def __init__(self, value: str) -> None:
        self.value = value

    def get(self) -> str:
        return self.value


def _window_with_service(state: str) -> "whisper_gui.WhisperGuiApp":
    app = whisper_gui.WhisperGuiApp.__new__(whisper_gui.WhisperGuiApp)
    app.ctl = mock.Mock()
    app.ctl.running.return_value = False
    app.host_var, app.port_var, app.token_var = _Var("0.0.0.0"), _Var("8001"), _Var("s3cret")
    app.config_file = Path("config.json")
    app.service_actions = []
    app.on_service = lambda action, note="": app.service_actions.append(action)
    app._refresh_service = lambda port=None: False
    app.service = ServiceStatus(state)
    return app


class ButtonsDriveTheServiceTests(unittest.TestCase):
    def test_start_starts_the_service_instead_of_a_second_server(self):
        app = _window_with_service("stopped")
        with (
            mock.patch.object(whisper_gui, "save_config"),
            mock.patch.object(whisper_gui, "shadowed_by_env", return_value=[]),
        ):
            app.on_start()
        self.assertEqual(app.service_actions, ["start"])
        app.ctl.start.assert_not_called()

    def test_stop_and_restart_act_on_the_service(self):
        app = _window_with_service("running")
        with (
            mock.patch.object(whisper_gui, "save_config"),
            mock.patch.object(whisper_gui, "shadowed_by_env", return_value=[]),
        ):
            app.on_stop()
            app.on_restart()
        self.assertEqual(app.service_actions, ["stop", "restart"])
        app.ctl.stop.assert_not_called()

    def test_restart_saves_the_form_first_so_edits_reach_the_service(self):
        app = _window_with_service("running")
        with (
            mock.patch.object(whisper_gui, "save_config") as save,
            mock.patch.object(whisper_gui, "shadowed_by_env", return_value=[]),
        ):
            app.on_restart()
        save.assert_called_once_with(Path("config.json"), "0.0.0.0", "8001", "s3cret")
        self.assertEqual(app.service_actions, ["restart"])

    def test_health_checks_use_the_services_saved_endpoint_not_unsaved_edits(self):
        app = _window_with_service("running")
        app.active = None
        app.port_var = _Var("9999")  # typed, not yet applied
        saved = {"host": "0.0.0.0", "port": "8001", "token": "s3cret"}
        with mock.patch.object(whisper_gui, "effective_config", return_value=saved):
            self.assertEqual(app._server_settings(), ("0.0.0.0", "8001", "s3cret"))


class _TokenWindow:
    """A window double for on_generate_token: records what it saved and restarted."""

    def __init__(self, service_state: str, child_running: bool) -> None:
        app = whisper_gui.WhisperGuiApp.__new__(whisper_gui.WhisperGuiApp)
        app.ctl = mock.Mock()
        app.ctl.running.return_value = child_running
        app.host_var, app.port_var = _Var("0.0.0.0"), _Var("8001")
        app.token_var = mock.Mock()
        app.config_file = Path("config.json")
        app.service = ServiceStatus(service_state)
        app._refresh_service = lambda port=None: False
        app._reveal_token = lambda reveal: None
        app._copy_to_clipboard = lambda text: True
        app.info = []
        app._set_info = app.info.append
        app.service_actions = []
        app.on_service = lambda action, note="": app.service_actions.append(action)
        app.on_restart = mock.Mock()
        self.app = app

    def generate(self, token: str = "new-key") -> mock.Mock:
        with (
            mock.patch.object(whisper_gui, "generate_token", return_value=token),
            mock.patch.object(whisper_gui, "save_config") as save,
            mock.patch.object(whisper_gui, "shadowed_by_env", return_value=[]),
        ):
            self.app.token_var.get.return_value = token
            self.app.on_generate_token()
        return save


class GenerateKeyAppliesItTests(unittest.TestCase):
    def test_with_the_service_the_key_is_saved_and_the_service_restarted(self):
        window = _TokenWindow("running", child_running=False)
        save = window.generate()
        save.assert_called_once_with(Path("config.json"), "0.0.0.0", "8001", "new-key")
        self.assertEqual(window.app.service_actions, ["restart"])

    def test_a_running_window_backend_is_restarted_with_the_key(self):
        window = _TokenWindow("not installed", child_running=True)
        save = window.generate()
        save.assert_called_once()
        window.app.on_restart.assert_called_once()

    def test_a_stopped_window_backend_only_saves(self):
        window = _TokenWindow("not installed", child_running=False)
        save = window.generate()
        save.assert_called_once()
        window.app.on_restart.assert_not_called()
        self.assertIn("next Start", window.app.info[-1])

    def test_a_key_that_cannot_be_saved_restarts_nothing(self):
        window = _TokenWindow("running", child_running=False)
        with (
            mock.patch.object(whisper_gui, "generate_token", return_value="k"),
            mock.patch.object(whisper_gui, "save_config", side_effect=PermissionError()),
            mock.patch.object(whisper_gui, "shadowed_by_env", return_value=[]),
        ):
            window.app.token_var.get.return_value = "k"
            window.app.on_generate_token()
        self.assertEqual(window.app.service_actions, [])
        self.assertIn("reinstall the backend", window.app.info[-1])


class ServiceStartAppliesSavedSettingsTests(unittest.TestCase):
    def test_start_on_a_running_service_restarts_it_so_edits_apply(self):
        app = _window_with_service("running")
        with (
            mock.patch.object(whisper_gui, "save_config"),
            mock.patch.object(whisper_gui, "shadowed_by_env", return_value=[]),
        ):
            app.on_start()
        self.assertEqual(app.service_actions, ["restart"])


class MacLaunchAgentTests(unittest.TestCase):
    """On macOS the installer runs the backend as a LaunchAgent holding the
    port; the window must drive it the same way it drives the Windows service."""

    def _launchd(self, status: str = "running", result: tuple[int, str] = (0, "")) -> mock.Mock:
        launchd = mock.Mock()
        launchd.service_status.return_value = status
        for name in ("start_service", "stop_service", "restart_service"):
            getattr(launchd, name).return_value = result
        return launchd

    def test_the_launch_agent_counts_as_the_installed_service(self):
        launchd = self._launchd("stopped")
        with (
            mock.patch.object(whisper_gui.sys, "platform", "darwin"),
            mock.patch.object(whisper_gui, "_launchd", return_value=launchd),
        ):
            status = whisper_gui.query_installed_service()
        self.assertTrue(whisper_gui.drives_service(status))
        self.assertEqual(status.state, "stopped")

    def test_without_a_launch_agent_the_window_runs_its_own_server(self):
        launchd = self._launchd("not installed")
        with (
            mock.patch.object(whisper_gui.sys, "platform", "darwin"),
            mock.patch.object(whisper_gui, "_launchd", return_value=launchd),
        ):
            self.assertFalse(whisper_gui.drives_service(whisper_gui.query_installed_service()))

    def test_restart_goes_to_launchctl_without_elevation(self):
        launchd = self._launchd()
        with (
            mock.patch.object(whisper_gui.sys, "platform", "darwin"),
            mock.patch.object(whisper_gui, "_launchd", return_value=launchd),
            mock.patch.object(whisper_gui.windows_admin, "control_service") as uac,
        ):
            whisper_gui.control_installed_service("restart")
        launchd.restart_service.assert_called_once()
        uac.assert_not_called()

    def test_a_launchctl_failure_is_reported(self):
        launchd = self._launchd(result=(5, "Boot-out failed: 5: Input/output error"))
        with (
            mock.patch.object(whisper_gui.sys, "platform", "darwin"),
            mock.patch.object(whisper_gui, "_launchd", return_value=launchd),
        ):
            with self.assertRaises(whisper_gui.windows_admin.ElevatedActionFailed) as caught:
                whisper_gui.control_installed_service("stop")
        self.assertIn("Input/output error", str(caught.exception))


class LaunchdRestartTests(unittest.TestCase):
    def setUp(self) -> None:
        path = Path(__file__).resolve().parents[1] / "packaging" / "macos" / "service_control.py"
        spec = importlib.util.spec_from_file_location("service_control", path)
        self.launchd = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.launchd)

    def test_a_loaded_agent_is_restarted_in_place(self):
        calls = []
        with mock.patch.object(self.launchd, "_run", side_effect=lambda cmd: calls.append(cmd) or (0, "")):
            self.launchd.restart_service()
        self.assertEqual(calls[-1][:3], ["launchctl", "kickstart", "-k"])

    def test_an_unloaded_agent_is_started(self):
        with (
            mock.patch.object(self.launchd, "_loaded", return_value=(113, "")),
            mock.patch.object(self.launchd, "start_service", return_value=(0, "")) as start,
        ):
            self.launchd.restart_service()
        start.assert_called_once()


if __name__ == "__main__":
    unittest.main()


class WindowsUserBackendWindowTests(unittest.TestCase):
    """On Windows the window drives the per-user backend, with no service and no UAC."""

    def test_windows_gets_the_user_backend_controller(self):
        with mock.patch.object(whisper_gui.os, "name", "nt"):
            self.assertIsInstance(whisper_gui.make_controller(), whisper_gui.UserBackendController)

    def test_start_on_a_running_backend_restarts_it_to_apply_the_settings(self):
        app = _window_with_service("not installed")
        ctl = mock.create_autospec(whisper_gui.UserBackendController, instance=True)
        ctl.running.side_effect = [True, False, False, True, True]
        ctl.start.return_value = "started on http://0.0.0.0:8001"
        app.ctl = ctl
        app.active = None
        app._generation = 0
        app._set_info = lambda text: None
        app._refresh_status = lambda: None
        with (
            mock.patch.object(whisper_gui, "save_config"),
            mock.patch.object(whisper_gui, "shadowed_by_env", return_value=[]),
            mock.patch.object(whisper_gui, "fetch_health", return_value=None),
            mock.patch.object(whisper_gui.threading, "Thread"),
        ):
            app.on_start()
        ctl.stop.assert_called_once()
        ctl.start.assert_called_once_with("0.0.0.0", "8001", "s3cret")
        self.assertEqual(app.service_actions, [])
