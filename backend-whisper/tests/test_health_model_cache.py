"""/health is open, so its model-cache block must not act as a filesystem oracle."""

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
class HealthModelCacheTests(unittest.TestCase):
    def setUp(self):
        self._prev_token = os.environ.get("SUBSMELT_WHISPER_TOKEN")
        os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)

    def tearDown(self):
        if self._prev_token is None:
            os.environ.pop("SUBSMELT_WHISPER_TOKEN", None)
        else:
            os.environ["SUBSMELT_WHISPER_TOKEN"] = self._prev_token

    def _model_cache(self, model: str, *, client=None, headers=None) -> dict:
        client = client or TestClient(main_module.app)
        resp = client.get("/health", params={"model": model}, headers=headers or {})
        self.assertEqual(resp.status_code, 200)
        return resp.json()["modelCache"]

    def test_arbitrary_path_ids_are_not_probed(self):
        for probe in ("/etc/passwd", "/etc/definitely-not-here", "~", "../x"):
            info = self._model_cache(probe)
            self.assertEqual(
                (info["cached"], info["cache_root"], info["cache_path"]),
                (None, None, None),
                probe,
            )

    def test_remote_tokenless_caller_gets_no_paths(self):
        info = self._model_cache("small")
        self.assertEqual(info["model"], "small")
        self.assertIn(info["cached"], (True, False))
        self.assertEqual((info["cache_root"], info["cache_path"]), (None, None))

    def test_local_tokenless_caller_sees_paths(self):
        info = self._model_cache("small", client=TestClient(main_module.app, client=("127.0.0.1", 4242)))
        self.assertIsInstance(info["cache_root"], str)

    def test_token_holder_sees_paths_and_stranger_does_not(self):
        os.environ["SUBSMELT_WHISPER_TOKEN"] = "s3cr3t"
        self.assertIsNone(self._model_cache("small")["cache_root"])
        self.assertIsNone(self._model_cache("small", headers={"Authorization": "Bearer nope"})["cache_root"])
        self.assertIsInstance(
            self._model_cache("small", headers={"Authorization": "Bearer s3cr3t"})["cache_root"], str
        )


if __name__ == "__main__":
    unittest.main()
