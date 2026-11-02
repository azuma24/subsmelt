"""Nemotron on a Mac must not fail on device=cuda stored by a Windows install."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from app import nemotron
from app.schemas import TranscribeRequest

METAL = {"os": "macos", "arch": "arm64", "accelerator": "metal", "gpuName": "Apple M5 Pro", "memoryMb": 49152}
CUDA = {"os": "windows", "arch": "x86_64", "accelerator": "cuda", "gpuName": "RTX", "memoryMb": 24564}


class _Stop(Exception):
    pass


def _request(device: str) -> TranscribeRequest:
    return TranscribeRequest(input_path="/media/a.mkv", model="nemotron-3.5-asr", device=device, compute_type="float16")


class NemotronDeviceTests(unittest.TestCase):
    def _leased_device(self, host: dict, device: str) -> str:
        leased = []

        def fake_lease(model, lease_device, compute_type):
            leased.append(lease_device)
            raise _Stop

        with (
            mock.patch("app.gpu.host_info", return_value=host),
            mock.patch.object(nemotron, "lease", side_effect=fake_lease),
            self.assertRaises(_Stop),
        ):
            list(nemotron.run(_request(device), Path("/tmp/a.wav"), None, 0.0))
        return leased[0]

    def test_cuda_on_a_metal_host_leases_cpu_and_lets_nemo_speech_pick_metal(self):
        with mock.patch("app.gpu.host_info", return_value=METAL):
            self.assertEqual(nemotron._cli_device(_request("cuda")), "auto")
        self.assertEqual(self._leased_device(METAL, "cuda"), "cpu")

    def test_cuda_on_a_cuda_host_is_kept(self):
        with mock.patch("app.gpu.host_info", return_value=CUDA):
            self.assertEqual(nemotron._cli_device(_request("cuda")), "cuda")
        self.assertEqual(self._leased_device(CUDA, "cuda"), "cuda")


if __name__ == "__main__":
    unittest.main()
