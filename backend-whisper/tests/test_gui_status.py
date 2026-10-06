"""Status-line reporting in the Whisper control window.

The window records the settings the running child was actually launched with,
and describes THAT rather than whatever is currently typed in the form — the
fields stay editable while the server runs, so a status built from them would
claim a port nothing is listening on, or silently drop the no-token warning.

Both helpers are pure and module-level so they can be exercised without a
display; whisper_gui.py imports fine headless (tkinter is behind a guard).
"""
import importlib.util
import unittest
from pathlib import Path

_MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "packaging" / "windows" / "tray" / "whisper_gui.py"
)
_spec = importlib.util.spec_from_file_location("whisper_gui", _MODULE_PATH)
whisper_gui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(whisper_gui)

LAN_NO_TOKEN = ("0.0.0.0", "8001", "")
LAN_WITH_TOKEN = ("0.0.0.0", "8001", "s3cret")
LOCAL_NO_TOKEN = ("127.0.0.1", "8001", "")


class LaunchedSettingsTests(unittest.TestCase):
    """Which settings the window should attribute to the running process."""

    def test_a_fresh_launch_adopts_the_form_values(self):
        self.assertEqual(
            whisper_gui.launched_settings(None, was_running=False, is_running=True,
                                          current=LAN_WITH_TOKEN),
            LAN_WITH_TOKEN,
        )

    def test_an_already_running_server_keeps_its_original_settings(self):
        # start() is a no-op when a child is already up, so the form values were
        # never applied to anything — adopting them would misreport the process.
        edited = ("127.0.0.1", "9999", "different")
        self.assertEqual(
            whisper_gui.launched_settings(LAN_WITH_TOKEN, was_running=True,
                                          is_running=True, current=edited),
            LAN_WITH_TOKEN,
        )

    def test_a_failed_launch_records_nothing(self):
        self.assertIsNone(
            whisper_gui.launched_settings(None, was_running=False, is_running=False,
                                          current=LAN_WITH_TOKEN)
        )

    def test_a_dead_process_clears_what_was_recorded(self):
        self.assertIsNone(
            whisper_gui.launched_settings(LAN_WITH_TOKEN, was_running=True,
                                          is_running=False, current=LAN_WITH_TOKEN)
        )


class PortConflictTests(unittest.TestCase):
    """Refusing to launch into a port another server already holds."""

    def test_names_the_address_that_is_taken(self):
        message = whisper_gui.port_conflict_message("0.0.0.0", "8001")
        self.assertIn("0.0.0.0", message)
        self.assertIn("8001", message)

    def test_says_it_did_not_start(self):
        # The operator must not be left thinking a server came up.
        self.assertIn("Not started", whisper_gui.port_conflict_message("0.0.0.0", "8001"))

    def test_names_the_usual_culprit_and_a_way_out(self):
        message = whisper_gui.port_conflict_message("127.0.0.1", "8001")
        self.assertIn("service", message)
        self.assertIn("different port", message)


class StatusLabelTests(unittest.TestCase):
    def test_stopped(self):
        self.assertEqual(
            whisper_gui.status_label(False, None, LAN_WITH_TOKEN), "○ Stopped"
        )

    def test_running_without_known_settings_stays_generic(self):
        # Nothing is known about how it was launched, so claim nothing about it.
        self.assertEqual(
            whisper_gui.status_label(True, None, LAN_WITH_TOKEN), "● Running"
        )

    def test_running_names_the_bind_address_and_port(self):
        label = whisper_gui.status_label(True, LAN_WITH_TOKEN, LAN_WITH_TOKEN)
        self.assertIn("0.0.0.0:8001", label)
        self.assertNotIn("no token", label)
        self.assertNotIn("restart", label)

    def test_a_tokenless_lan_bind_is_flagged(self):
        # The whole point of the detailed branch: this backend is open to the
        # network right now, and the status line is where that has to show.
        self.assertIn(
            "no token", whisper_gui.status_label(True, LAN_NO_TOKEN, LAN_NO_TOKEN)
        )

    def test_a_tokenless_loopback_bind_is_not_flagged(self):
        self.assertNotIn(
            "no token", whisper_gui.status_label(True, LOCAL_NO_TOKEN, LOCAL_NO_TOKEN)
        )

    def test_edited_fields_are_marked_as_pending_a_restart(self):
        label = whisper_gui.status_label(True, LAN_WITH_TOKEN, ("0.0.0.0", "9001", "s3cret"))
        self.assertIn("restart", label.lower())
        # Still describes the process, not the edit.
        self.assertIn("8001", label)
        self.assertNotIn("9001", label)

    def test_the_warning_follows_the_running_process_not_the_form(self):
        # Typing a token into the form does not retroactively secure a backend
        # that is already serving without one.
        label = whisper_gui.status_label(True, LAN_NO_TOKEN, LAN_WITH_TOKEN)
        self.assertIn("no token", label)
        self.assertIn("restart", label.lower())


if __name__ == "__main__":
    unittest.main()
