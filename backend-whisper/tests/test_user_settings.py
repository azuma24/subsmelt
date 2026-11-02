"""settings.json: the user-editable half of the backend's configuration.

The installed service runs as SYSTEM and config.json names programs it runs
(ffmpeg, nemo_speech), so config.json stays administrator-only. Host, port and
API key live in settings.json beside it, which Users may edit: the control
window saves a new key without a UAC prompt. The server takes ONLY those three
keys from settings.json, so editing it cannot redirect what SYSTEM executes.
"""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_server

_GUI_CONFIG = Path(__file__).resolve().parents[1] / "packaging" / "windows" / "tray" / "gui_config.py"
_spec = importlib.util.spec_from_file_location("gui_config", _GUI_CONFIG)
gui_config = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gui_config)

_ENV_KEYS = ("SUBSMELT_WHISPER_HOST", "SUBSMELT_WHISPER_PORT", "SUBSMELT_WHISPER_TOKEN", "SUBSMELT_FFMPEG")


class _Dir(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.config = self.dir / "config.json"
        self.settings = self.dir / "settings.json"

    def write(self, path: Path, data: dict) -> None:
        path.write_text(json.dumps(data), encoding="utf-8")


class ServerReadsUserSettingsTests(_Dir):
    def load(self) -> "run_server.ServerConfig":
        env = {k: v for k, v in os.environ.items() if k not in _ENV_KEYS}
        env["SUBSMELT_WHISPER_CONFIG"] = str(self.config)
        with mock.patch.dict(os.environ, env, clear=True):
            return run_server.load_config()

    def test_host_port_and_token_come_from_settings_json(self):
        self.write(self.config, {"host": "0.0.0.0", "port": 8001, "token": "old"})
        self.write(self.settings, {"host": "127.0.0.1", "port": "9100", "token": "new"})
        config = self.load()
        self.assertEqual((config.host, config.port, config.token), ("127.0.0.1", 9100, "new"))

    def test_an_emptied_token_in_settings_turns_auth_off(self):
        # Clearing the key in the window must not fall back to the old one.
        self.write(self.config, {"token": "old"})
        self.write(self.settings, {"token": ""})
        self.assertFalse(self.load().token)

    def test_settings_json_cannot_name_a_program_for_the_service(self):
        self.write(self.config, {"ffmpeg": "C:\\Program Files\\SubSmelt\\ffmpeg.exe"})
        self.write(self.settings, {"ffmpeg": "C:\\Users\\Public\\evil.exe", "nemo_speech": "x", "model_dir": "y"})
        config = self.load()
        self.assertEqual(config.ffmpeg, "C:\\Program Files\\SubSmelt\\ffmpeg.exe")
        self.assertIsNone(config.nemo_speech)
        self.assertIsNone(config.model_dir)

    def test_without_settings_json_config_json_still_applies(self):
        self.write(self.config, {"port": 8123, "token": "kept"})
        config = self.load()
        self.assertEqual((config.port, config.token), (8123, "kept"))


class WindowSavesToSettingsTests(_Dir):
    def test_a_save_writes_settings_json_and_leaves_config_json_alone(self):
        self.write(self.config, {"token": "old", "ffmpeg": "f.exe"})
        before = self.config.read_text(encoding="utf-8")
        gui_config.save_config(self.config, "127.0.0.1", "9100", "new")
        self.assertEqual(self.config.read_text(encoding="utf-8"), before)
        self.assertEqual(
            json.loads(self.settings.read_text(encoding="utf-8")),
            {"host": "127.0.0.1", "port": "9100", "token": "new"},
        )

    def test_settings_json_wins_when_loading(self):
        self.write(self.config, {"port": 8001, "token": "old"})
        self.write(self.settings, {"port": "9100", "token": "new"})
        values = gui_config.load_config(self.config)
        self.assertEqual((values["port"], values["token"]), ("9100", "new"))

    def test_a_cleared_key_stays_cleared_on_reload(self):
        self.write(self.config, {"token": "old"})
        gui_config.save_config(self.config, "0.0.0.0", "8001", "")
        self.assertEqual(gui_config.load_config(self.config)["token"], "")

    def test_an_unreadable_config_json_is_fine_when_settings_json_has_the_values(self):
        self.write(self.settings, {"host": "0.0.0.0", "port": "8001", "token": "k"})
        self.config.write_text("{not json", encoding="utf-8")
        self.assertEqual(gui_config.load_config(self.config)["token"], "k")

    def test_a_folder_users_cannot_create_files_in_still_takes_the_save(self):
        # Users may modify settings.json but not create files in the data dir,
        # so the temp-file-and-replace save has to fall back to writing in place.
        self.write(self.settings, {"token": "old"})
        real_replace = Path.replace

        def no_create(path, target):
            raise PermissionError("cannot create in data dir")

        with mock.patch.object(Path, "replace", no_create):
            gui_config.save_config(self.config, "0.0.0.0", "8001", "new")
        self.assertEqual(json.loads(self.settings.read_text(encoding="utf-8"))["token"], "new")
        self.assertIs(Path.replace, real_replace)
        self.assertFalse(list(self.dir.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
