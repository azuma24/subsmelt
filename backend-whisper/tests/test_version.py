import os
import unittest

from app.version import TRANSPORT_MODES, backend_version


class BackendVersionTests(unittest.TestCase):
    def setUp(self):
        self._prev = os.environ.get("SUBSMELT_WHISPER_VERSION")

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("SUBSMELT_WHISPER_VERSION", None)
        else:
            os.environ["SUBSMELT_WHISPER_VERSION"] = self._prev

    def test_default_version_is_non_empty(self):
        os.environ.pop("SUBSMELT_WHISPER_VERSION", None)
        self.assertTrue(backend_version())

    def test_env_override_wins(self):
        os.environ["SUBSMELT_WHISPER_VERSION"] = "9.9.9-test"
        self.assertEqual(backend_version(), "9.9.9-test")

    def test_blank_env_falls_back_to_default(self):
        os.environ["SUBSMELT_WHISPER_VERSION"] = "   "
        self.assertTrue(backend_version())
        self.assertNotEqual(backend_version(), "")

    def test_transport_modes(self):
        self.assertEqual(TRANSPORT_MODES, ["shared", "upload"])


# Endpoint test for GET /version (skipped where fastapi is absent).
try:
    from fastapi.testclient import TestClient

    import app.main as main_module
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TestClient = None
    main_module = None
    ENDPOINT_IMPORT_ERROR = exc
else:
    ENDPOINT_IMPORT_ERROR = None


@unittest.skipIf(ENDPOINT_IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {ENDPOINT_IMPORT_ERROR}")
class VersionEndpointTests(unittest.TestCase):
    def test_version_endpoint_is_open_and_reports_transports(self):
        # /version stays open (no token) like /health.
        client = TestClient(main_module.app)
        prev = os.environ.get("SUBSMELT_WHISPER_TOKEN")
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        try:
            resp = client.get("/version")
        finally:
            if prev is None:
                os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
            else:
                os.environ["SUBSMELT_WHISPER_TOKEN"] = prev
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["version"])
        self.assertEqual(body["transportModes"], ["shared", "upload"])
        self.assertIn("capabilities", body)
        self.assertEqual(body["capabilities"]["version"], body["version"])


if __name__ == "__main__":
    unittest.main()
