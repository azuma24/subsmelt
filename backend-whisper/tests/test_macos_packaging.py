"""The macOS launchd install and uninstall scripts, run against a throwaway HOME.

The scripts use macOS tools (plutil, ditto, scutil), so these run only on a
Mac. ``--skip-launchd`` keeps them away from the real launchd domain; the
bundle's executable is a wrapper around this checkout's run_server.py, so the
token is minted by the real ``--generate-token --save``.
"""

import json
import os
import plistlib
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "packaging" / "macos"


@unittest.skipUnless(sys.platform == "darwin", "the launchd scripts use macOS tools")
class LaunchdInstallTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tmp = Path(self._tmp.name).resolve()
        self.home = tmp / "home"
        self.home.mkdir()
        self.unzipped = tmp / "SubSmelt Whisper"
        server = self.unzipped / "whisper-server" / "whisper-server"
        server.parent.mkdir(parents=True)
        server.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{ROOT / "run_server.py"}" "$@"\n', encoding="utf-8")
        server.chmod(server.stat().st_mode | stat.S_IXUSR)

        self.data_dir = self.home / "Library" / "Application Support" / "SubSmelt"
        self.config = self.data_dir / "config.json"
        self.info = self.data_dir / "backend-info.txt"
        self.plist = self.home / "Library" / "LaunchAgents" / "com.subsmelt.whisper.plist"
        self.app_dir = self.home / "Applications" / "SubSmelt Whisper"

    def _run(self, script: str, *args: str) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
        result = subprocess.run(
            ["/bin/bash", str(SCRIPTS / script), *args, "--skip-launchd"], env=env, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def _install(self, *args: str) -> subprocess.CompletedProcess:
        return self._run("install-launchd.sh", str(self.unzipped), *args)

    def _config(self) -> dict:
        return json.loads(self.config.read_text(encoding="utf-8"))

    def test_the_plist_holds_only_the_program_and_log_paths(self):
        self._install()

        with self.plist.open("rb") as fh:
            plist = plistlib.load(fh)
        logs = f"{self.home}/Library/Logs/SubSmelt Whisper"
        self.assertEqual(
            plist,
            {
                "Label": "com.subsmelt.whisper",
                "ProgramArguments": [f"{self.home}/Applications/SubSmelt Whisper/whisper-server/whisper-server"],
                "RunAtLoad": True,
                "KeepAlive": {"SuccessfulExit": False},
                "StandardOutPath": f"{logs}/stdout.log",
                "StandardErrorPath": f"{logs}/stderr.log",
            },
        )
        self.assertNotIn("EnvironmentVariables", plist)
        self.assertTrue((self.app_dir / "whisper-server" / "whisper-server").is_file())

    def test_settings_and_a_new_token_go_to_an_owner_only_config(self):
        result = self._install()

        config = self._config()
        token = config.pop("token")
        self.assertEqual(
            config,
            {
                "port": 8001,
                "media_root": f"{self.data_dir}/media",
                "model_dir": f"{self.data_dir}/models",
            },
        )
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.info.stat().st_mode & 0o777, 0o600)
        self.assertIn(f"Backend token: {token}\n", self.info.read_text(encoding="utf-8"))
        self.assertNotIn(token, result.stdout + result.stderr)

    def test_a_reinstall_keeps_the_token_and_unrelated_keys(self):
        self._install()
        config = self._config()
        config.update({"log_level": "debug", "ffmpeg": "/old/install/ffmpeg"})
        self.config.write_text(json.dumps(config), encoding="utf-8")

        self._install("--port", "9001")

        self.assertEqual(
            self._config(),
            {
                "port": 9001,
                "media_root": config["media_root"],
                "model_dir": config["model_dir"],
                "token": config["token"],
                "log_level": "debug",
            },
        )

    def test_uninstall_removes_the_app_and_settings_but_keeps_models(self):
        self._install()
        weights = self.data_dir / "models" / "hub" / "weights.gguf"
        weights.parent.mkdir(parents=True)
        weights.write_bytes(b"GGUF")

        self._run("uninstall-launchd.sh")

        self.assertEqual(
            [path.exists() for path in (self.plist, self.app_dir, self.config, self.info, weights)],
            [False, False, False, False, True],
        )


if __name__ == "__main__":
    unittest.main()
