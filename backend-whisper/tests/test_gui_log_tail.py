import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

# Import whisper_gui without executing its tkinter/pystray paths — those guards
# already fall back to None, so the module imports on a headless box.
_GUI = Path(__file__).resolve().parents[1] / "packaging" / "windows" / "tray" / "whisper_gui.py"
_spec = importlib.util.spec_from_file_location("whisper_gui_for_test", _GUI)
whisper_gui = importlib.util.module_from_spec(_spec)
try:
    _spec.loader.exec_module(whisper_gui)  # type: ignore[union-attr]
except Exception as exc:  # pragma: no cover - environment dependent
    whisper_gui = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


@unittest.skipIf(IMPORT_ERROR is not None, f"whisper_gui unavailable: {IMPORT_ERROR}")
class ReadLogTailTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.path = Path(self._dir.name) / "whisper-server.log"

    def tearDown(self):
        self._dir.cleanup()

    def test_missing_file_explains_itself(self):
        lines, note = whisper_gui.read_log_tail(self.path, 100)
        self.assertEqual(lines, [])
        self.assertIn("No log file", note)

    def test_empty_file_explains_itself(self):
        self.path.write_text("", encoding="utf-8")
        lines, note = whisper_gui.read_log_tail(self.path, 100)
        self.assertEqual(lines, [])
        self.assertIn("empty", note)

    def test_returns_the_last_lines(self):
        self.path.write_text(
            "\n".join(f"INFO line {i}" for i in range(1, 301)) + "\n", encoding="utf-8"
        )
        lines, note = whisper_gui.read_log_tail(self.path, 5)
        self.assertEqual(len(lines), 5)
        self.assertTrue(lines[-1].endswith("line 300"))
        self.assertIn("last 5 lines", note)

    def test_large_file_is_truncated_without_a_partial_first_line(self):
        # The seek lands mid-line; that fragment must not surface as a line.
        big = "\n".join(f"INFO {'x' * 300} line {i}" for i in range(1, 4000))
        self.path.write_text(big, encoding="utf-8")
        lines, note = whisper_gui.read_log_tail(self.path, 2000)
        self.assertIn("truncated", note)
        self.assertTrue(all(line.startswith("INFO ") for line in lines))

    def test_undecodable_bytes_do_not_raise(self):
        self.path.write_bytes(b"INFO fine\n\xff\xfe not utf8\nINFO also fine\n")
        lines, _ = whisper_gui.read_log_tail(self.path, 10)
        self.assertEqual(lines[0], "INFO fine")
        self.assertEqual(lines[-1], "INFO also fine")

    def test_unreadable_path_is_reported_not_raised(self):
        # A directory where a file is expected is the portable stand-in for an
        # unreadable path (the service account owning the log is the real case).
        lines, note = whisper_gui.read_log_tail(Path(self._dir.name), 10)
        self.assertEqual(lines, [])
        self.assertTrue(note)


@unittest.skipIf(IMPORT_ERROR is not None, f"whisper_gui unavailable: {IMPORT_ERROR}")
class ResolveLogFileTests(unittest.TestCase):
    """The server supports overriding its log path; the viewer must follow the
    same precedence or it reports "no log file" while the real one is elsewhere."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._prev_env = os.environ.get("SUBSMELT_WHISPER_LOG_FILE")
        self._prev_cfg = os.environ.get("SUBSMELT_WHISPER_CONFIG")
        os.environ.pop("SUBSMELT_WHISPER_LOG_FILE", None)

    def tearDown(self):
        for key, prev in (
            ("SUBSMELT_WHISPER_LOG_FILE", self._prev_env),
            ("SUBSMELT_WHISPER_CONFIG", self._prev_cfg),
        ):
            if prev is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = prev
        self._dir.cleanup()

    def test_env_wins(self):
        os.environ["SUBSMELT_WHISPER_LOG_FILE"] = r"D:\logs\custom.log"
        self.assertEqual(
            whisper_gui.resolve_log_file(), Path(r"D:\logs\custom.log")
        )

    def test_config_log_file_is_used_when_env_is_unset(self):
        cfg = Path(self._dir.name) / "config.json"
        cfg.write_text('{"log_file": "/var/log/elsewhere.log"}', encoding="utf-8")
        os.environ["SUBSMELT_WHISPER_CONFIG"] = str(cfg)
        self.assertEqual(
            whisper_gui.resolve_log_file(), Path("/var/log/elsewhere.log")
        )

    def test_falls_back_to_the_default_path(self):
        cfg = Path(self._dir.name) / "config.json"
        cfg.write_text("{}", encoding="utf-8")
        os.environ["SUBSMELT_WHISPER_CONFIG"] = str(cfg)
        self.assertEqual(
            whisper_gui.resolve_log_file(),
            whisper_gui.LOG_DIR / whisper_gui.DEFAULT_LOG_FILE_NAME,
        )

    def test_malformed_config_falls_back_rather_than_raising(self):
        cfg = Path(self._dir.name) / "config.json"
        cfg.write_text("{not json", encoding="utf-8")
        os.environ["SUBSMELT_WHISPER_CONFIG"] = str(cfg)
        self.assertEqual(
            whisper_gui.resolve_log_file(),
            whisper_gui.LOG_DIR / whisper_gui.DEFAULT_LOG_FILE_NAME,
        )


@unittest.skipIf(IMPORT_ERROR is not None, f"whisper_gui unavailable: {IMPORT_ERROR}")
class VersionTests(unittest.TestCase):
    def test_env_override_wins(self):
        prev = os.environ.get("SUBSMELT_WHISPER_VERSION")
        os.environ["SUBSMELT_WHISPER_VERSION"] = "1.2.3-test"
        try:
            self.assertEqual(whisper_gui._resolve_app_version(), "1.2.3-test")
        finally:
            if prev is None:
                os.environ.pop("SUBSMELT_WHISPER_VERSION", None)
            else:
                os.environ["SUBSMELT_WHISPER_VERSION"] = prev

    def test_falls_back_to_the_package_version(self):
        prev = os.environ.pop("SUBSMELT_WHISPER_VERSION", None)
        try:
            from app.version import _DEFAULT_VERSION

            self.assertEqual(whisper_gui._resolve_app_version(), _DEFAULT_VERSION)
        finally:
            if prev is not None:
                os.environ["SUBSMELT_WHISPER_VERSION"] = prev

    def test_never_raises(self):
        self.assertIsInstance(whisper_gui._resolve_app_version(), str)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
