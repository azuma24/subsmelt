import unittest

import app.model_cache as mc
from app.model_cache import cache_dir_name_for_model, repo_id_for_model


class ModelRepoResolutionTests(unittest.TestCase):
    def setUp(self):
        self._prev = mc._FW_MODELS

    def tearDown(self):
        mc._FW_MODELS = self._prev

    def test_fallback_when_registry_unavailable(self):
        mc._FW_MODELS = {}  # simulate faster-whisper absent
        self.assertEqual(repo_id_for_model("small"), "Systran/faster-whisper-small")
        # turbo is not a Systran repo — override map supplies the right org.
        self.assertEqual(repo_id_for_model("large-v3-turbo"), "mobiuslabsgmbh/faster-whisper-large-v3-turbo")
        # distil models live under faster-DISTIL-whisper-<model>, not the default.
        self.assertEqual(repo_id_for_model("distil-large-v3"), "Systran/faster-distil-whisper-large-v3")

    def test_faster_whisper_registry_takes_precedence(self):
        # When faster-whisper's own registry is present, we use it verbatim.
        mc._FW_MODELS = {
            "small": "Systran/faster-whisper-small",
            "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
            "distil-large-v3": "Systran/faster-whisper-distil-large-v3",
        }
        self.assertEqual(repo_id_for_model("distil-large-v3"), "Systran/faster-whisper-distil-large-v3")
        self.assertEqual(repo_id_for_model("large-v3-turbo"), "mobiuslabsgmbh/faster-whisper-large-v3-turbo")

    def test_cache_dir_name_matches_repo(self):
        mc._FW_MODELS = {}
        self.assertEqual(cache_dir_name_for_model("small"), "models--Systran--faster-whisper-small")
        self.assertEqual(
            cache_dir_name_for_model("large-v3-turbo"),
            "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo",
        )


if __name__ == "__main__":
    unittest.main()
