"""The launcher as the Windows service runs it: one log line per record, a
log file that stays inside the data dir, and the --service hand-off.

pywin32 is Windows-only, so winservice.py keeps the Service Control Manager
glue behind a function and the parts exercised here run anywhere.
"""

import json
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_server
import winservice

ENV_KEYS = (
    "SUBSMELT_DATA_DIR",
    "SUBSMELT_WHISPER_CONFIG",
    "SUBSMELT_WHISPER_LOG_FILE",
    "SUBSMELT_WHISPER_LOG_LEVEL",
    "SUBSMELT_WHISPER_TOKEN",
)


class LauncherTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self._saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        os.environ["SUBSMELT_DATA_DIR"] = str(self.data_dir)
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _write_config(self, payload: dict) -> None:
        (self.data_dir / "config.json").write_text(json.dumps(payload), encoding="utf-8")


class FileLoggingTests(LauncherTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._root_handlers = list(logging.getLogger().handlers)
        self.addCleanup(self._detach_added_handlers)

    def _detach_added_handlers(self) -> None:
        root = logging.getLogger()
        for handler in list(root.handlers):
            if handler not in self._root_handlers:
                root.removeHandler(handler)
                handler.close()

    def test_each_uvicorn_record_is_written_once(self):
        # The live Windows backend showed every uvicorn line three times: the
        # same handler sat on root AND on uvicorn / uvicorn.error / uvicorn.access,
        # and those propagate to root.
        log_file = self.data_dir / "logs" / "whisper-server.log"
        config = mock.Mock(log_file=str(log_file), log_level="info")

        self.assertTrue(run_server.configure_file_logging(config))
        logging.getLogger("uvicorn.access").info("GET /health 200")
        logging.getLogger("uvicorn.error").warning("worker hiccup")

        lines = log_file.read_text(encoding="utf-8").splitlines()
        self.assertEqual([line.split(": ", 1)[1] for line in lines], ["GET /health 200", "worker hiccup"])

    def test_uvicorn_loggers_keep_the_configured_level(self):
        log_file = self.data_dir / "logs" / "whisper-server.log"
        config = mock.Mock(log_file=str(log_file), log_level="warning")

        run_server.configure_file_logging(config)
        logging.getLogger("uvicorn.access").info("GET /health 200")
        logging.getLogger("uvicorn.error").warning("worker hiccup")

        self.assertEqual(log_file.read_text(encoding="utf-8").count("\n"), 1)
        self.assertIn("worker hiccup", log_file.read_text(encoding="utf-8"))


class LogFileGuardTests(LauncherTestCase):
    def _load_log_file(self) -> str | None:
        with mock.patch.object(sys, "stderr"):
            return run_server.load_config().log_file

    def test_a_config_log_file_inside_the_logs_dir_is_used(self):
        inside = self.data_dir / "logs" / "custom.log"
        self._write_config({"log_file": str(inside)})
        self.assertEqual(self._load_log_file(), str(inside))

    def test_a_config_log_file_outside_the_logs_dir_falls_back_to_the_default(self):
        # The service runs as SYSTEM; a config edit must not point its log
        # anywhere on the disk.
        self._write_config({"log_file": str(self.data_dir / ".." / "elsewhere.log")})
        expected = str(self.data_dir / "logs" / "whisper-server.log") if sys.platform == "win32" else None
        self.assertEqual(self._load_log_file(), expected)

    def test_the_environment_log_file_is_not_guarded(self):
        # The GUI launches its own child with an explicit log path; only the
        # shared, hand-editable config.json is the concern.
        elsewhere = self.data_dir / ".." / "child.log"
        os.environ["SUBSMELT_WHISPER_LOG_FILE"] = str(elsewhere)
        self.assertEqual(self._load_log_file(), str(elsewhere))


class ServiceFlagTests(LauncherTestCase):
    def test_service_flag_hands_off_to_the_service_control_manager(self):
        with mock.patch.object(winservice, "run_as_service", return_value=7) as dispatcher:
            self.assertEqual(run_server.main(["--service"]), 7)
        dispatcher.assert_called_once_with()


class ServiceSessionStopTests(unittest.TestCase):
    def test_stop_asks_the_running_server_to_exit(self):
        session = winservice.ServiceSession()
        server = mock.Mock(should_exit=False)
        session.attach(server)
        self.assertFalse(server.should_exit)

        session.stop()

        self.assertTrue(server.should_exit)

    def test_a_stop_before_the_server_exists_still_exits_it(self):
        # SvcStop can arrive while SvcDoRun is still loading config and
        # probing CUDA; the server built afterwards must not run forever.
        session = winservice.ServiceSession()
        session.stop()

        server = mock.Mock(should_exit=False)
        session.attach(server)

        self.assertTrue(server.should_exit)


class ServerKwargsTests(LauncherTestCase):
    def test_the_service_and_the_console_build_the_same_uvicorn_config(self):
        self._write_config({"host": "127.0.0.1", "port": 9123, "log_level": "debug"})
        config = run_server.load_config()
        self.assertEqual(
            run_server.uvicorn_kwargs(config, file_logging=True),
            {"host": "127.0.0.1", "port": 9123, "log_level": "debug", "reload": False, "log_config": None},
        )
        self.assertEqual(
            run_server.uvicorn_kwargs(config, file_logging=False),
            {"host": "127.0.0.1", "port": 9123, "log_level": "debug", "reload": False},
        )


if __name__ == "__main__":
    unittest.main()
