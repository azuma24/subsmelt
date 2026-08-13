import importlib
import os
import unittest

try:
    from fastapi.testclient import TestClient

    import app.main as main_module
except ModuleNotFoundError as exc:  # pragma: no cover - optional deps
    TestClient = None
    main_module = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


@unittest.skipIf(IMPORT_ERROR is not None, f"backend optional dependencies unavailable: {IMPORT_ERROR}")
class AuthTokenTests(unittest.TestCase):
    """Phase 1 shared-secret auth.

    The token is read live from the environment by ``require_token`` so we can
    flip it per-test without reimporting. We force the fake-transcribe path off
    the real model and target ``/preflight`` because it exercises the dependency
    without needing real media (a 400/401/422 still proves the auth gate fired
    before the body was processed).
    """

    def setUp(self):
        os.environ["SUBSMELT_WHISPER_FAKE"] = "1"
        self.client = TestClient(main_module.app)
        self._prev_token = os.environ.get("SUBSMELT_WHISPER_TOKEN")

    def tearDown(self):
        if self._prev_token is None:
            os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        else:
            os.environ["SUBSMELT_WHISPER_TOKEN"] = self._prev_token

    def _body(self):
        return {"input_path": "/media/clip.mkv", "model": "small"}

    def test_token_unset_request_passes_auth(self):
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        resp = self.client.post("/preflight", json=self._body())
        # Auth is disabled → request is processed (never 401). The path may be
        # unsafe/missing (400/422) but that is past the auth gate.
        self.assertNotEqual(resp.status_code, 401)

    def test_token_set_correct_bearer_passes_auth(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        resp = self.client.post(
            "/preflight",
            json=self._body(),
            headers={"Authorization": "Bearer s3cr3t"},
        )
        self.assertNotEqual(resp.status_code, 401)

    def test_token_set_correct_x_header_passes_auth(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        resp = self.client.post(
            "/preflight",
            json=self._body(),
            headers={"X-Subsmelt-Token": "s3cr3t"},
        )
        self.assertNotEqual(resp.status_code, 401)

    def test_token_set_wrong_token_rejected(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        resp = self.client.post(
            "/preflight",
            json=self._body(),
            headers={"Authorization": "Bearer nope"},
        )
        self.assertEqual(resp.status_code, 401)

    def test_token_set_missing_header_rejected(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        resp = self.client.post("/preflight", json=self._body())
        self.assertEqual(resp.status_code, 401)

    def test_health_stays_open_and_reports_auth_required(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["capabilities"]["authRequired"])

        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["capabilities"]["authRequired"])


if __name__ == "__main__":
    unittest.main()
