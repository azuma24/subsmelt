import test from "node:test";
import assert from "node:assert/strict";
import { transcriptionHost } from "./transcription.js";

test("transcriptionHost returns a Mac backend's host unchanged", () => {
  assert.deepEqual(
    transcriptionHost({
      devices: ["cpu"],
      host: { os: "macos", arch: "arm64", accelerator: "metal", gpuName: "Apple M5 Pro", memoryMb: 49152 },
    }),
    { os: "macos", arch: "arm64", accelerator: "metal", gpuName: "Apple M5 Pro", memoryMb: 49152 },
  );
});

test("transcriptionHost returns a Windows backend's host unchanged", () => {
  assert.deepEqual(
    transcriptionHost({
      devices: ["cpu", "cuda"],
      host: { os: "windows", arch: "x86_64", accelerator: "cuda", gpuName: "NVIDIA GeForce RTX 4090", memoryMb: 24564 },
    }),
    { os: "windows", arch: "x86_64", accelerator: "cuda", gpuName: "NVIDIA GeForce RTX 4090", memoryMb: 24564 },
  );
});

test("transcriptionHost infers the accelerator from devices on a backend that predates host", () => {
  assert.deepEqual(transcriptionHost({ devices: ["cpu", "cuda"] }), { os: "unknown", accelerator: "cuda" });
  assert.deepEqual(transcriptionHost({ devices: ["cpu"] }), { os: "unknown", accelerator: "cpu" });
  assert.deepEqual(transcriptionHost(undefined), { os: "unknown", accelerator: "cpu" });
});
