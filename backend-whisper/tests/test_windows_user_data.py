"""The Windows backend runs as the signed-in user, from that user's folder.

Older installs ran it as the SubSmeltWhisper service from C:\\ProgramData\\SubSmelt,
whose files only administrators could change: every start, stop and key change
asked for a UAC prompt, and a backend run any other way could not download
models. The data now lives in %LOCALAPPDATA%\\SubSmelt; the first start
carries host, port and key over from the old install, and a fresh install
gets a key of its own.
"""

import json
import tempfile
import unittest
from pathlib import Path

import run_server


class WindowsDataDirTests(unittest.TestCase):
    def test_the_data_dir_is_the_users_local_app_data(self):
        env = {"LOCALAPPDATA": r"C:\Users\user\AppData\Local"}
        self.assertEqual(
            run_server.default_data_dir(env, platform="win32"),
            Path(r"C:\Users\user\AppData\Local") / "SubSmelt",
        )

    def test_an_explicit_data_dir_still_wins(self):
        env = {"LOCALAPPDATA": r"C:\Users\user\AppData\Local", "SUBSMELT_DATA_DIR": r"D:\SubSmelt"}
        self.assertEqual(run_server.default_data_dir(env, platform="win32"), Path(r"D:\SubSmelt"))


class PrepareUserDataTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.user = root / "Local" / "SubSmelt"
        self.legacy = root / "ProgramData" / "SubSmelt"
        self.legacy.mkdir(parents=True)

    def settings(self) -> dict:
        return json.loads((self.user / "settings.json").read_text(encoding="utf-8"))

    def prepare(self) -> None:
        run_server.prepare_user_data(self.user, self.legacy)

    def test_host_port_and_key_carry_over_from_the_service_install(self):
        (self.legacy / "config.json").write_text(
            json.dumps({"port": 8002, "token": "old", "ffmpeg": r"C:\x\ffmpeg.exe"}), encoding="utf-8"
        )
        (self.legacy / "settings.json").write_text(json.dumps({"port": 8001, "token": "newer"}), encoding="utf-8")
        self.prepare()
        # settings.json wins over config.json, as it did for the service; nothing else is copied.
        self.assertEqual(self.settings(), {"port": 8001, "token": "newer"})

    def test_a_fresh_install_gets_a_key_of_its_own(self):
        self.prepare()
        token = self.settings()["token"]
        self.assertGreaterEqual(len(token), 32)

    def test_existing_user_settings_are_never_overwritten(self):
        self.user.mkdir(parents=True)
        (self.user / "settings.json").write_text(json.dumps({"port": 9100, "token": "mine"}), encoding="utf-8")
        (self.legacy / "settings.json").write_text(json.dumps({"port": 8001, "token": "old"}), encoding="utf-8")
        self.prepare()
        self.assertEqual(self.settings(), {"port": 9100, "token": "mine"})

    def test_a_key_turned_off_on_purpose_stays_off(self):
        self.user.mkdir(parents=True)
        (self.user / "settings.json").write_text(json.dumps({"token": ""}), encoding="utf-8")
        self.prepare()
        self.assertEqual(self.settings()["token"], "")

    def test_an_unreadable_old_install_is_skipped_and_a_key_minted(self):
        (self.legacy / "config.json").write_text("{not json", encoding="utf-8")
        self.prepare()
        self.assertGreaterEqual(len(self.settings()["token"]), 32)


class BundledFfmpegTests(unittest.TestCase):
    def test_the_frozen_windows_backend_uses_the_ffmpeg_beside_it(self):
        # The service install wrote this path into config.json; the per-user
        # backend has no such config, so it must find its own copy.
        from unittest import mock

        with tempfile.TemporaryDirectory() as tmp:
            exe = Path(tmp) / "run_server.exe"
            (Path(tmp) / "ffmpeg.exe").write_bytes(b"")
            with (
                mock.patch.object(run_server.sys, "platform", "win32"),
                mock.patch.object(run_server.sys, "frozen", True, create=True),
                mock.patch.object(run_server.sys, "executable", str(exe)),
            ):
                self.assertEqual(run_server.bundled_ffmpeg(), str(Path(tmp).resolve() / "ffmpeg.exe"))
