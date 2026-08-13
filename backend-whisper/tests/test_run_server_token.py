"""Tests for ``run_server.py --generate-token``.

The headless install (Windows service, Docker, plain CLI) has no control window,
so the launcher itself has to be able to mint the backend's API key. These tests
cover the two things that make that safe to run on a live install: it must not
start the server, and it must not silently invalidate a token that clients are
already using.
"""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import run_server
from app.token_gen import looks_generated


class GenerateTokenCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.config = Path(self._tmp.name) / "config.json"

        # run_server resolves config + token from the environment, so pin both
        # rather than inheriting whatever the developer's shell has set.
        self._saved_env = {
            key: os.environ.get(key)
            for key in ("SUBSMELT_WHISPER_CONFIG", "SUBSMELT_WHISPER_TOKEN")
        }
        os.environ["SUBSMELT_WHISPER_CONFIG"] = str(self.config)
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _run(self, *argv: str) -> tuple[int, str]:
        """Run the CLI, returning its exit code and everything it printed.

        stdout and stderr are merged on purpose: the caller cares what the
        operator was told, and the refusals are errors that correctly go to
        stderr while the key itself goes to stdout.
        """
        buffer = io.StringIO()
        with redirect_stdout(buffer), redirect_stderr(buffer):
            code = run_server.main(list(argv))
        return code, buffer.getvalue()

    def _write_config(self, payload: dict) -> None:
        self.config.write_text(json.dumps(payload), encoding="utf-8")

    # ---- printing ----

    def test_prints_a_strong_token_and_exits(self):
        code, output = self._run("--generate-token")
        self.assertEqual(code, 0)
        # The token is the only machine-readable thing here; find it by strength
        # rather than by pinning the surrounding prose.
        self.assertTrue(any(looks_generated(word) for word in output.split()))

    def test_tells_the_operator_where_to_paste_it(self):
        _, output = self._run("--generate-token")
        self.assertIn("Speech to Text", output)

    def test_printing_alone_does_not_touch_the_config(self):
        self._write_config({"host": "0.0.0.0"})
        self._run("--generate-token")
        self.assertNotIn("token", json.loads(self.config.read_text(encoding="utf-8")))

    def test_each_invocation_mints_a_different_token(self):
        _, first = self._run("--generate-token")
        _, second = self._run("--generate-token")
        self.assertNotEqual(first, second)

    # ---- saving ----

    def test_save_writes_the_token_into_the_config(self):
        code, output = self._run("--generate-token", "--save")
        self.assertEqual(code, 0)
        stored = json.loads(self.config.read_text(encoding="utf-8"))["token"]
        self.assertTrue(looks_generated(stored))
        self.assertIn(stored, output)

    def test_save_preserves_unrelated_keys(self):
        # config.json is shared with the installed service and hand-editable; a
        # token write must not be a config rewrite.
        self._write_config({"host": "127.0.0.1", "port": 9001, "model_dir": "D:/models"})
        self._run("--generate-token", "--save")
        stored = json.loads(self.config.read_text(encoding="utf-8"))
        self.assertEqual(stored["host"], "127.0.0.1")
        self.assertEqual(stored["port"], 9001)
        self.assertEqual(stored["model_dir"], "D:/models")

    def test_save_refuses_to_replace_an_existing_token(self):
        self._write_config({"token": "already-in-use"})
        code, output = self._run("--generate-token", "--save")
        self.assertEqual(code, 1)
        self.assertIn("--force", output)
        # Every configured client would 401 on a silent rotation.
        self.assertEqual(
            json.loads(self.config.read_text(encoding="utf-8"))["token"],
            "already-in-use",
        )

    def test_force_replaces_an_existing_token(self):
        self._write_config({"token": "already-in-use"})
        code, _ = self._run("--generate-token", "--save", "--force")
        self.assertEqual(code, 0)
        stored = json.loads(self.config.read_text(encoding="utf-8"))["token"]
        self.assertNotEqual(stored, "already-in-use")
        self.assertTrue(looks_generated(stored))

    def test_save_warns_when_an_env_token_shadows_the_file(self):
        # run_server gives SUBSMELT_WHISPER_TOKEN precedence over config.json, so
        # a saved token would not be the one actually enforced.
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "from-the-environment"
        _, output = self._run("--generate-token", "--save", "--force")
        self.assertIn("SUBSMELT_WHISPER_TOKEN", output)

    def test_force_without_save_is_rejected(self):
        code, output = self._run("--generate-token", "--force")
        self.assertEqual(code, 2)
        self.assertIn("--save", output)


if __name__ == "__main__":
    unittest.main()
