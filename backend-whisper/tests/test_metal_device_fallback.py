"""A Metal host runs faster-whisper on the CPU even when the stored settings
say CUDA: a backend moved from a Windows PC keeps device=cuda/float16 in
config.json, and the Mac must not try to load a CUDA model it cannot have."""

import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from app import gpu, whisper_engine
from app.schemas import TranscribeRequest

METAL_HOST = {"os": "macos", "arch": "arm64", "accelerator": "metal", "gpuName": "Apple M5 Pro", "memoryMb": 49152}
CUDA_HOST = {"os": "windows", "arch": "x86_64", "accelerator": "cuda", "gpuName": "RTX 4090", "memoryMb": 24576}


class _FakeModel:
    def transcribe(self, audio_path, **kwargs):
        return iter(()), SimpleNamespace(language="en", duration=1.0)


class LeaseArgsTests(unittest.TestCase):
    def setUp(self):
        self._host = mock.patch.object(gpu, "host_info", return_value=METAL_HOST)
        self._host.start()
        self.addCleanup(self._host.stop)

    def _request(self, **overrides):
        return TranscribeRequest(input_path="clip.mkv", model="small", language="auto", **overrides)

    def _lease_args(self, request):
        captured = {}

        @contextmanager
        def fake_lease(*args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            yield _FakeModel()

        with mock.patch.object(whisper_engine, "_require_faster_whisper", lambda: None):
            with mock.patch.object(whisper_engine, "lease", fake_lease):
                list(whisper_engine.run(request, Path("clip.wav"), None, 60.0))
        return SimpleNamespace(args=captured["args"], kwargs=captured["kwargs"])

    def test_a_cuda_request_from_a_windows_setup_runs_cpu_int8_on_a_metal_host(self):
        request = self._request(device="cuda", compute_type="float16")

        args = self._lease_args(request)

        self.assertEqual(args.args, ("small", "cpu", "int8"))

    def test_a_valid_cpu_compute_type_is_kept_on_a_metal_host(self):
        request = self._request(device="cuda", compute_type="int8_float32")

        args = self._lease_args(request)

        self.assertEqual(args.args, ("small", "cpu", "int8_float32"))

    def test_a_plain_cpu_request_is_untouched_on_a_metal_host(self):
        request = self._request(device="cpu", compute_type="int8")

        args = self._lease_args(request)

        self.assertEqual(args.args, ("small", "cpu", "int8"))


class EffectiveDeviceTests(unittest.TestCase):
    def _with_host(self, host):
        return mock.patch.object(gpu, "host_info", return_value=host)

    def test_cuda_becomes_cpu_only_on_a_metal_host(self):
        with self._with_host(METAL_HOST):
            self.assertEqual(gpu.effective_device("cuda"), "cpu")
            self.assertEqual(gpu.effective_device("CUDA"), "cpu")
            self.assertEqual(gpu.effective_device("cpu"), "cpu")
            self.assertEqual(gpu.effective_device(None), "cpu")
        with self._with_host(CUDA_HOST):
            self.assertEqual(gpu.effective_device("cuda"), "cuda")
            self.assertEqual(gpu.effective_device(None), "cpu")

    def test_non_cpu_compute_types_fall_back_to_int8_on_a_metal_host(self):
        with self._with_host(METAL_HOST):
            self.assertEqual(gpu.effective_compute_type("float16"), "int8")
            self.assertEqual(gpu.effective_compute_type(None), "int8")
            self.assertEqual(gpu.effective_compute_type("int8"), "int8")
            self.assertEqual(gpu.effective_compute_type("int8_float32"), "int8_float32")
            self.assertEqual(gpu.effective_compute_type("float32"), "float32")
        with self._with_host(CUDA_HOST):
            self.assertEqual(gpu.effective_compute_type("float16"), "float16")
            self.assertEqual(gpu.effective_compute_type(None), None)


if __name__ == "__main__":
    unittest.main()
