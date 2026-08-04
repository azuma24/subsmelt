"""Tests for the Whisper control window's settings persistence and warnings.

gui_config.py lives under packaging/windows/tray/ (frozen into the GUI exe, not
the server), so it is loaded here by path.
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "packaging" / "windows" / "tray" / "gui_config.py"
)
_spec = importlib.util.spec_from_file_location("gui_config", _MODULE_PATH)
gui_config = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gui_config)


class LoadConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_missing_file_yields_defaults(self):
        values = gui_config.load_config(self.dir / "nope.json")
        self.assertEqual(values["host"], gui_config.DEFAULT_HOST)
        self.assertEqual(values["port"], gui_config.DEFAULT_PORT)
        self.assertEqual(values["token"], "")

    def test_malformed_file_never_raises(self):
        path = self.dir / "config.json"
        path.write_text("{not json at all", encoding="utf-8")
        # A broken config must leave the window usable, not stop it opening.
        self.assertEqual(gui_config.load_config(path)["port"], gui_config.DEFAULT_PORT)

        path.write_text('"a bare string"', encoding="utf-8")
        self.assertEqual(gui_config.load_config(path)["host"], gui_config.DEFAULT_HOST)

    def test_saved_values_are_read_back(self):
        path = self.dir / "config.json"
        gui_config.save_config(path, "127.0.0.1", "9001", "s3cr3t")
        values = gui_config.load_config(path)
        self.assertEqual(values, {"host": "127.0.0.1", "port": "9001", "token": "s3cr3t"})

    def test_numeric_port_from_a_hand_edited_file_is_accepted(self):
        path = self.dir / "config.json"
        path.write_text(json.dumps({"port": 9100}), encoding="utf-8")
        self.assertEqual(gui_config.load_config(path)["port"], "9100")


class SaveConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "config.json"
        self.addCleanup(self._tmp.cleanup)

    def test_unknown_keys_are_preserved(self):
        # config.json is shared with the service and hand-editable; a GUI save
        # must not discard settings this window does not know about.
        self.path.write_text(json.dumps({"model_dir": "D:/models", "log_level": "debug"}), encoding="utf-8")

        gui_config.save_config(self.path, "0.0.0.0", "8001", "")

        saved = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(saved["model_dir"], "D:/models")
        self.assertEqual(saved["log_level"], "debug")
        self.assertEqual(saved["host"], "0.0.0.0")

    def test_clearing_the_token_removes_it(self):
        gui_config.save_config(self.path, "0.0.0.0", "8001", "s3cr3t")
        self.assertIn("token", json.loads(self.path.read_text(encoding="utf-8")))

        # Emptying the field must actually clear the secret — a stale token left
        # behind would keep enforcing auth the user thinks they turned off.
        gui_config.save_config(self.path, "0.0.0.0", "8001", "   ")
        self.assertNotIn("token", json.loads(self.path.read_text(encoding="utf-8")))

    def test_creates_the_directory_when_absent(self):
        nested = Path(self._tmp.name) / "SubSmelt" / "config.json"
        gui_config.save_config(nested, "0.0.0.0", "8001", "")
        self.assertTrue(nested.is_file())

    def test_a_broken_existing_file_is_replaced_not_fatal(self):
        self.path.write_text("{{{", encoding="utf-8")
        gui_config.save_config(self.path, "0.0.0.0", "8001", "")
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["host"], "0.0.0.0")


class BindWarningTests(unittest.TestCase):
    def test_wide_bind_without_a_token_warns(self):
        warning = gui_config.bind_warning("0.0.0.0", "")
        self.assertIsNotNone(warning)
        self.assertIn("no token", warning)

    def test_no_warning_when_a_token_is_set_or_bound_to_loopback(self):
        self.assertIsNone(gui_config.bind_warning("0.0.0.0", "s3cr3t"))
        self.assertIsNone(gui_config.bind_warning("127.0.0.1", ""))
        # Whitespace is not a token.
        self.assertIsNotNone(gui_config.bind_warning("0.0.0.0", "   "))


class ConfigPathTests(unittest.TestCase):
    def test_path_follows_the_data_dir_override(self):
        path = gui_config.config_path({"SUBSMELT_DATA_DIR": str(Path("D:/SubSmeltData"))})
        self.assertEqual(path, Path("D:/SubSmeltData") / "config.json")

    def test_defaults_to_programdata(self):
        self.assertEqual(gui_config.config_path({}), Path(r"C:\ProgramData\SubSmelt") / "config.json")


if __name__ == "__main__":
    unittest.main()
