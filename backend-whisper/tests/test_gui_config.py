"""Tests for the Whisper control window's settings persistence and warnings.

gui_config.py lives under packaging/windows/tray/ (frozen into the GUI exe, not
the server), so it is loaded here by path.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_MODULE_PATH = Path(__file__).resolve().parents[1] / "packaging" / "windows" / "tray" / "gui_config.py"
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

    def test_defaults_to_programdata_on_windows(self):
        with mock.patch.object(sys, "platform", "win32"):
            self.assertEqual(gui_config.config_path({}), Path(r"C:\ProgramData\SubSmelt") / "config.json")

    def test_explicit_config_override_wins(self):
        # run_server reads SUBSMELT_WHISPER_CONFIG ahead of the data dir; if the
        # window ignored it, it would edit a file the server never opens.
        env = {
            "SUBSMELT_WHISPER_CONFIG": str(Path("E:/custom/whisper.json")),
            "SUBSMELT_DATA_DIR": str(Path("D:/SubSmeltData")),
        }
        self.assertEqual(gui_config.config_path(env), Path("E:/custom/whisper.json"))

    def test_blank_override_falls_through(self):
        self.assertEqual(
            gui_config.config_path({"SUBSMELT_WHISPER_CONFIG": "   ", "SUBSMELT_DATA_DIR": str(Path("D:/D"))}),
            Path("D:/D") / "config.json",
        )


class EnvShadowingTests(unittest.TestCase):
    def test_machine_env_vars_that_outrank_the_file_are_reported(self):
        # install-service.ps1 always sets SUBSMELT_WHISPER_PORT machine-wide, and
        # run_server gives env precedence — so saving a port here cannot change
        # what the installed service uses, and the window must not imply it did.
        names = gui_config.shadowed_by_env({"SUBSMELT_WHISPER_PORT": "8001"})
        self.assertEqual(names, ["SUBSMELT_WHISPER_PORT"])

        note = gui_config.shadowed_note(names)
        self.assertIn("SUBSMELT_WHISPER_PORT", note)
        self.assertIn("precedence", note)

    def test_nothing_reported_when_the_environment_is_clean(self):
        self.assertEqual(gui_config.shadowed_by_env({}), [])
        self.assertEqual(gui_config.shadowed_by_env({"SUBSMELT_WHISPER_PORT": ""}), [])
        self.assertIsNone(gui_config.shadowed_note([]))

    def test_all_three_shadowing_variables_are_covered(self):
        names = gui_config.shadowed_by_env(
            {
                "SUBSMELT_WHISPER_HOST": "0.0.0.0",
                "SUBSMELT_WHISPER_PORT": "8001",
                "SUBSMELT_WHISPER_TOKEN": "s3cr3t",
            }
        )
        self.assertEqual(len(names), 3)


if __name__ == "__main__":
    unittest.main()


class GenerateTokenTests(unittest.TestCase):
    """The Generate button's backing call.

    Thin by design — the entropy lives in app/token_gen.py — so these pin the
    wiring rather than re-testing the generator.
    """

    def test_returns_a_fresh_strong_token(self):
        first, second = gui_config.generate_token(), gui_config.generate_token()
        self.assertNotEqual(first, second)
        self.assertGreaterEqual(len(first), 40)

    def test_generated_token_survives_a_save_reload_round_trip(self):
        # The window saves the generated key to config.json and the server reads
        # it back; a token mangled in transit would 401 with nothing to show why.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            token = gui_config.generate_token()
            gui_config.save_config(path, "0.0.0.0", "8001", token)
            self.assertEqual(gui_config.load_config(path)["token"], token)

    def test_a_generated_token_clears_the_bind_warning(self):
        self.assertIsNone(gui_config.bind_warning("0.0.0.0", gui_config.generate_token()))


class SourceBackendRootTests(unittest.TestCase):
    """Where a source checkout's backend-whisper/ is, found lazily and safely."""

    def test_finds_the_checkout_root_from_the_real_module_path(self):
        root = gui_config.source_backend_root()
        self.assertIsNotNone(root)
        self.assertTrue((root / "run_server.py").is_file())

    def test_a_shallow_path_yields_none_instead_of_raising(self):
        # A onefile exe extracts into %TEMP%; a shallow TEMP has fewer than
        # three parents and parents[3] raised IndexError at import time.
        self.assertIsNone(gui_config.source_backend_root("/t/gui_config.py"))

    def test_a_frozen_build_has_no_source_root(self):
        with mock.patch.object(sys, "frozen", True, create=True):
            self.assertIsNone(gui_config.source_backend_root())

    def test_dev_server_script_sits_in_the_root(self):
        self.assertEqual(gui_config.dev_server_script(), gui_config.source_backend_root() / "run_server.py")
        self.assertIsNone(gui_config.dev_server_script("/t/gui_config.py"))


class DataDirTests(unittest.TestCase):
    """One data-dir rule for every platform the control apps will run on."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_windows_keeps_programdata(self):
        self.assertEqual(gui_config.data_dir({}, platform="win32"), Path(r"C:\ProgramData\SubSmelt"))

    def test_macos_uses_application_support(self):
        self.assertEqual(
            gui_config.data_dir({}, platform="darwin"),
            self.home / "Library" / "Application Support" / "SubSmelt",
        )

    def test_linux_uses_xdg_data_home_or_its_default(self):
        self.assertEqual(gui_config.data_dir({}, platform="linux"), self.home / ".local" / "share" / "subsmelt")
        self.assertEqual(
            gui_config.data_dir({"XDG_DATA_HOME": "/srv/xdg"}, platform="linux"),
            Path("/srv/xdg") / "subsmelt",
        )

    def test_explicit_data_dir_wins_everywhere(self):
        for platform in ("win32", "darwin", "linux"):
            self.assertEqual(
                gui_config.data_dir({"SUBSMELT_DATA_DIR": "/opt/subsmelt"}, platform=platform),
                Path("/opt/subsmelt"),
            )

    def test_defaults_to_the_running_platform(self):
        with mock.patch.object(sys, "platform", "darwin"):
            self.assertEqual(gui_config.data_dir({}), self.home / "Library" / "Application Support" / "SubSmelt")

    def test_agrees_with_run_server_on_every_platform(self):
        # The server and the control apps are frozen into different exes and
        # cannot share the function, so this pins the two copies together.
        import run_server

        environments = ({}, {"SUBSMELT_DATA_DIR": "/opt/subsmelt"}, {"XDG_DATA_HOME": "/srv/xdg"})
        for platform in ("win32", "darwin", "linux"):
            for env in environments:
                with self.subTest(platform=platform, env=env):
                    self.assertEqual(
                        gui_config.data_dir(env, platform=platform),
                        run_server.default_data_dir(env, platform=platform),
                    )


class EffectiveConfigTests(unittest.TestCase):
    """host/port/token as run_server will resolve them: env, then file, then default."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.config = Path(self._tmp.name) / "config.json"
        self.addCleanup(self._tmp.cleanup)
        self.env = {"SUBSMELT_WHISPER_CONFIG": str(self.config)}

    def test_config_json_overrides_the_defaults(self):
        self.config.write_text(json.dumps({"port": 9000, "host": "127.0.0.1"}), encoding="utf-8")
        values = gui_config.effective_config(self.env)
        self.assertEqual((values["host"], values["port"], values["token"]), ("127.0.0.1", "9000", ""))

    def test_env_overrides_config_json(self):
        self.config.write_text(json.dumps({"port": 9000, "token": "file"}), encoding="utf-8")
        values = gui_config.effective_config({**self.env, "SUBSMELT_WHISPER_PORT": "9100"})
        self.assertEqual((values["port"], values["token"]), ("9100", "file"))

    def test_a_missing_file_yields_the_defaults(self):
        self.assertEqual(gui_config.effective_config(self.env)["port"], gui_config.DEFAULT_PORT)
