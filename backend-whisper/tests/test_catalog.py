import unittest

from app.catalog import ADVERTISED_MODELS, descriptor_for, to_wire
from app.engine import LanguageNotSupportedError
from app.preflight import evaluate_gpu_safety, evaluate_model_safety, model_ram_requirements_mb

NEMOTRON_LANGUAGES = [
    "en",
    "es",
    "fr",
    "it",
    "pt",
    "pt-BR",
    "pt-PT",
    "nl",
    "de",
    "tr",
    "ru",
    "ar",
    "hi",
    "ja",
    "ko",
    "vi",
    "uk",
    "pl",
    "sv",
    "cs",
    "nb",
    "no",
    "da",
    "bg",
    "fi",
    "hr",
    "sk",
    "zh",
    "zh-CN",
    "hu",
    "ro",
    "et",
]


class CatalogTests(unittest.TestCase):
    def test_advertised_models_in_order(self):
        self.assertEqual(
            ADVERTISED_MODELS,
            (
                "tiny",
                "base",
                "small",
                "medium",
                "large-v1",
                "large-v2",
                "large-v3",
                "distil-large-v3",
                "large-v3-turbo",
                "nemotron-3.5-asr",
            ),
        )

    def test_descriptor_lookup_is_case_insensitive_and_none_for_paths(self):
        self.assertEqual(descriptor_for("Nemotron-3.5-ASR").engine, "nemotron")
        self.assertEqual(descriptor_for("Small").engine, "whisper")
        self.assertIsNone(descriptor_for("/models/my-whisper"))
        self.assertIsNone(descriptor_for("ginormous"))

    def test_nemotron_wire_shape(self):
        wire = to_wire(descriptor_for("nemotron-3.5-asr"), available=True, reason=None)
        self.assertEqual(
            wire,
            {
                "id": "nemotron-3.5-asr",
                "engine": "nemotron",
                "label": "Nemotron 3.5 ASR",
                "sizeMb": 742,
                "requiredRamMb": 3072,
                "requiredVramMb": 1536,
                "languages": NEMOTRON_LANGUAGES,
                "supports": {
                    "prompt": False,
                    "beamSize": False,
                    "conditionOnPreviousText": False,
                    "vad": False,
                    "computeType": False,
                    "wordTimestamps": True,
                    "translateTask": False,
                },
                "available": True,
                "unavailableReason": None,
            },
        )

    def test_whisper_wire_shape(self):
        wire = to_wire(descriptor_for("distil-large-v3"), available=True, reason=None)
        self.assertEqual(
            wire,
            {
                "id": "distil-large-v3",
                "engine": "whisper",
                "label": "Whisper distil-large-v3",
                "sizeMb": 1510,
                "requiredRamMb": 12288,
                "requiredVramMb": 6144,
                "languages": ["en"],
                "supports": {
                    "prompt": True,
                    "beamSize": True,
                    "conditionOnPreviousText": True,
                    "vad": True,
                    "computeType": True,
                    "wordTimestamps": True,
                    "translateTask": False,
                },
                "available": True,
                "unavailableReason": None,
            },
        )
        self.assertEqual(to_wire(descriptor_for("small"), available=True, reason=None)["languages"], "all")

    def test_unavailable_reason_is_carried(self):
        wire = to_wire(descriptor_for("nemotron-3.5-asr"), available=False, reason="nemo-speech runtime not found")
        self.assertEqual((wire["available"], wire["unavailableReason"]), (False, "nemo-speech runtime not found"))

    def test_language_error_carries_model_and_language(self):
        err = LanguageNotSupportedError("distil-large-v3", "ja", "Use large-v3.")
        self.assertEqual((err.model, err.language, str(err)), ("distil-large-v3", "ja", "Use large-v3."))


class PreflightCatalogTests(unittest.TestCase):
    def test_ram_requirements_come_from_the_catalog(self):
        self.assertEqual(model_ram_requirements_mb("nemotron-3.5-asr"), {"required": 3072, "recommended": 4096})
        self.assertEqual(model_ram_requirements_mb("Large-V3"), {"required": 16384, "recommended": 32768})

    def test_low_ram_suggests_a_smaller_whisper_model(self):
        result = evaluate_model_safety("large-v3", 4096)
        self.assertEqual(
            (result["safe"], result["code"], result["suggested_model"]), (False, "insufficient_ram", "small")
        )

    def test_low_ram_never_suggests_a_whisper_model_for_nemotron(self):
        result = evaluate_model_safety("nemotron-3.5-asr", 2048)
        self.assertEqual((result["safe"], result["code"], result["suggested_model"]), (False, "insufficient_ram", None))

    def test_low_vram_never_suggests_a_whisper_model_for_nemotron(self):
        result = evaluate_gpu_safety("nemotron-3.5-asr", 1024)
        self.assertEqual(
            (result["safe"], result["code"], result["suggested_model"]), (False, "insufficient_vram", None)
        )
        self.assertEqual(evaluate_gpu_safety("large-v3", 2048)["suggested_model"], "small")


if __name__ == "__main__":
    unittest.main()
