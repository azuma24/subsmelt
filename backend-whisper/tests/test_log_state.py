import os
import tempfile
import unittest

try:
    from app.log_state import get_log_state, log_file_path, set_log_state
except ModuleNotFoundError as exc:  # pragma: no cover - deps may be absent locally
    get_log_state = log_file_path = set_log_state = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None

try:
    from fastapi.testclient import TestClient

    from app.main import app
except Exception as exc:  # pragma: no cover - fastapi/multipart may be absent
    TestClient = None
    app = None
    API_IMPORT_ERROR = exc
else:
    API_IMPORT_ERROR = None


@unittest.skipIf(IMPORT_ERROR is not None, f"backend deps unavailable: {IMPORT_ERROR}")
class LogStateTests(unittest.TestCase):
    def tearDown(self):
        set_log_state(None, False, None)

    def test_defaults_to_inactive(self):
        set_log_state(None, False, None)
        state = get_log_state()
        self.assertFalse(state["active"])
        self.assertIsNone(state["file"])

    def test_records_success_and_failure(self):
        set_log_state("/var/log/whisper.log", True)
        self.assertEqual(log_file_path(), "/var/log/whisper.log")
        self.assertTrue(get_log_state()["active"])

        set_log_state("/var/log/whisper.log", False, "PermissionError")
        state = get_log_state()
        self.assertFalse(state["active"])
        self.assertEqual(state["error"], "PermissionError")

    def test_snapshot_is_a_copy(self):
        # Callers must not be able to mutate the record through the snapshot.
        set_log_state("/a.log", True)
        get_log_state()["active"] = False
        self.assertTrue(get_log_state()["active"])


@unittest.skipIf(
    API_IMPORT_ERROR is not None, f"fastapi unavailable: {API_IMPORT_ERROR}"
)
class LogEndpointTests(unittest.TestCase):
    def setUp(self):
        # Local caller: /logs requires a token OR a loopback client, and
        # TestClient's default host ("testclient") is neither.
        self.client = TestClient(app, client=("127.0.0.1", 51000))
        self._dir = tempfile.TemporaryDirectory()
        self.log = os.path.join(self._dir.name, "whisper-server.log")

    def tearDown(self):
        set_log_state(None, False, None)
        self._dir.cleanup()

    def _write(self, count):
        with open(self.log, "w", encoding="utf-8") as fh:
            fh.write("\n".join(f"INFO line {i}" for i in range(1, count + 1)) + "\n")

    def test_health_reports_logging_state(self):
        set_log_state(self.log, True)
        body = self.client.get("/health").json()
        self.assertEqual(body["logging"]["file"], self.log)
        self.assertTrue(body["logging"]["active"])

    def test_health_reports_why_logging_is_off(self):
        # The whole point: a silent failure is indistinguishable from a broken
        # logger, so the reason has to reach the client.
        set_log_state("C:/denied/whisper-server.log", False, "PermissionError: denied")
        logging_state = self.client.get("/health").json()["logging"]
        self.assertFalse(logging_state["active"])
        self.assertIn("denied", logging_state["error"])

    def test_tail_returns_the_last_lines(self):
        self._write(500)
        set_log_state(self.log, True)
        body = self.client.get("/logs?lines=3").json()
        self.assertEqual(len(body["lines"]), 3)
        self.assertTrue(body["lines"][-1].endswith("line 500"))
        self.assertTrue(body["active"])

    def test_tail_caps_the_requested_line_count(self):
        self._write(10)
        set_log_state(self.log, True)
        self.assertEqual(self.client.get("/logs?lines=99999").status_code, 422)

    def test_tail_of_a_large_file_drops_the_partial_first_line(self):
        # The seek lands mid-line; that fragment must not be returned as a line.
        with open(self.log, "w", encoding="utf-8") as fh:
            fh.write("\n".join(f"INFO {'x' * 200} line {i}" for i in range(1, 6000)))
        set_log_state(self.log, True)
        body = self.client.get("/logs?lines=2000").json()
        self.assertTrue(body.get("truncated"))
        self.assertTrue(all(line.startswith("INFO ") for line in body["lines"]))

    def test_missing_file_is_data_not_an_error(self):
        set_log_state(os.path.join(self._dir.name, "absent.log"), True)
        body = self.client.get("/logs").json()
        self.assertEqual(body["lines"], [])
        self.assertIn("does not exist", body["error"])

    def test_no_log_configured(self):
        set_log_state(None, False, "no log file configured")
        body = self.client.get("/logs").json()
        self.assertEqual(body["lines"], [])
        self.assertIsNone(body["file"])


@unittest.skipIf(
    API_IMPORT_ERROR is not None, f"fastapi unavailable: {API_IMPORT_ERROR}"
)
class LogEndpointAuthTests(unittest.TestCase):
    """require_token is a no-op with no token configured, and the server binds
    0.0.0.0 by default — so the log tail, which discloses accumulated content,
    additionally requires the caller to be local when auth is off."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.log = os.path.join(self._dir.name, "whisper-server.log")
        with open(self.log, "w", encoding="utf-8") as fh:
            fh.write("INFO secret media path /media/x.mkv\n")
        set_log_state(self.log, True)

    def tearDown(self):
        set_log_state(None, False, None)
        self._dir.cleanup()
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)

    def _client(self, host):
        return TestClient(app, client=(host, 51000))

    def test_tokenless_local_caller_is_allowed(self):
        self.assertEqual(self._client("127.0.0.1").get("/logs").status_code, 200)

    def test_tokenless_remote_caller_is_refused(self):
        response = self._client("192.168.1.50").get("/logs")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"]["code"], "token-required")

    def test_remote_caller_with_the_right_token_is_allowed(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cret"
        response = self._client("192.168.1.50").get(
            "/logs", headers={"X-Subsmelt-Token": "s3cret"}
        )
        self.assertEqual(response.status_code, 200)

    def test_remote_caller_with_a_wrong_token_is_refused(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cret"
        response = self._client("192.168.1.50").get(
            "/logs", headers={"X-Subsmelt-Token": "nope"}
        )
        self.assertEqual(response.status_code, 401)

    def test_health_stays_open_to_remote_callers(self):
        # /health is deliberately unauthenticated; this change must not alter it.
        self.assertEqual(self._client("192.168.1.50").get("/health").status_code, 200)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
