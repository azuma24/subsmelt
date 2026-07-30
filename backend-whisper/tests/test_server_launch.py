"""Tests for the tray/GUI run_server resolver and the Windows data-dir defaults.

server_launch.py lives under packaging/windows/tray/ (it is frozen into the tray
and GUI exes, not into the server), so it is loaded here by path.
"""
import importlib.util
import tempfile
import unittest
from pathlib import Path

import run_server

_MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "packaging" / "windows" / "tray" / "server_launch.py"
)
_spec = importlib.util.spec_from_file_location("server_launch", _MODULE_PATH)
server_launch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server_launch)


class ServerExeLookupTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    @staticmethod
    def _touch(path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")
        return path

    def test_finds_sibling_executable(self):
        exe_dir = self.root / "whisper-server"
        expected = self._touch(exe_dir / "run_server")
        found, _searched = server_launch.find_server_exe(exe_dir, env={}, windows=False)
        self.assertEqual(found, expected)

    def test_finds_bundle_subdirectory_when_launched_from_dist(self):
        # The failing real-world case: whisper-gui.exe left in dist\ with the
        # server one level down in dist\whisper-server\.
        expected = self._touch(self.root / "whisper-server" / "run_server")
        found, _searched = server_launch.find_server_exe(self.root, env={}, windows=False)
        self.assertEqual(found, expected)

    def test_finds_bundle_next_to_the_apps_own_directory(self):
        expected = self._touch(self.root / "whisper-server" / "run_server")
        found, _searched = server_launch.find_server_exe(
            self.root / "tools", env={}, windows=False)
        self.assertEqual(found, expected)

    def test_env_override_wins_over_probed_locations(self):
        self._touch(self.root / "run_server")
        override = self._touch(self.root / "custom" / "run_server")
        found, _searched = server_launch.find_server_exe(
            self.root,
            env={server_launch.SERVER_EXE_ENV: str(override)},
            windows=False,
        )
        self.assertEqual(found, override)

    def test_missing_executable_reports_every_probed_path(self):
        found, searched = server_launch.find_server_exe(
            self.root / "empty", env={}, windows=False)
        self.assertIsNone(found)
        self.assertTrue(searched)

        error = server_launch.ServerExecutableNotFound(searched)
        message = str(error)
        self.assertIn("run_server executable not found", message)
        self.assertIn(server_launch.SERVER_EXE_ENV, message)
        for path in searched:
            self.assertIn(str(path), message)

    def test_windows_flag_selects_the_exe_suffix(self):
        self.assertEqual(server_launch.server_exe_name(windows=True), "run_server.exe")
        self.assertEqual(server_launch.server_exe_name(windows=False), "run_server")

    def test_dev_command_requires_an_existing_script(self):
        with self.assertRaises(server_launch.ServerExecutableNotFound):
            server_launch.resolve_server_command(self.root / "missing_run_server.py")

        script = self._touch(self.root / "run_server.py")
        command = server_launch.resolve_server_command(script)
        self.assertEqual(command[-1], str(script))


class WindowsDataDirDefaultsTests(unittest.TestCase):
    def test_windows_defaults_point_at_the_packaging_data_dir(self):
        self.assertEqual(
            run_server.default_config_path(env={}, windows=True),
            str(Path(run_server.DEFAULT_WINDOWS_DATA_DIR) / "config.json"),
        )
        self.assertEqual(
            run_server.default_log_file(env={}, windows=True),
            str(Path(run_server.DEFAULT_WINDOWS_DATA_DIR) / "logs" / "whisper-server.log"),
        )

    def test_data_dir_env_override_is_honoured(self):
        env = {"SUBSMELT_DATA_DIR": str(Path("D:/SubSmeltData"))}
        self.assertEqual(
            run_server.default_config_path(env=env, windows=True),
            str(Path("D:/SubSmeltData") / "config.json"),
        )

    def test_non_windows_keeps_env_only_config_and_console_logging(self):
        self.assertIsNone(run_server.default_config_path(env={}, windows=False))
        self.assertIsNone(run_server.default_log_file(env={}, windows=False))


if __name__ == "__main__":
    unittest.main()
