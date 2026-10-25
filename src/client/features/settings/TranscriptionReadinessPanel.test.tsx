import test from "node:test";
import assert from "node:assert/strict";
import type { UseQueryResult } from "@tanstack/react-query";
import { renderPage } from "../../test-render";
import type { TranscriptionHealth } from "../../types";
import { TranscriptionReadinessPanel } from "./TranscriptionReadinessPanel";

type Capabilities = NonNullable<NonNullable<TranscriptionHealth["health"]>["capabilities"]>;

function renderPanel(
  capabilities: Capabilities,
  settingsOverrides: Record<string, string> = {},
  tokenAccepted?: boolean | null,
): string {
  const healthQuery = {
    data: { ok: true, endpointReachable: true, health: { ffmpeg: true, capabilities, tokenAccepted } },
    isLoading: false,
    isFetching: false,
    refetch: () => {},
  } as unknown as UseQueryResult<TranscriptionHealth>;
  const settings = {
    transcription_enabled: "1",
    transcription_backend_url: "http://whisper:8001",
    ...settingsOverrides,
  };
  return renderPage(<TranscriptionReadinessPanel settings={settings} healthQuery={healthQuery} dirty={false} />).text;
}

const WINDOWS_SETTINGS = { transcription_device: "cuda", transcription_compute_type: "float16" };

test("a Mac backend reads as the chip on Metal with its shared memory", () => {
  const text = renderPanel({
    devices: ["cpu"],
    gpus: [{ name: "Apple M5 Pro", total_vram_mb: 49152, free_vram_mb: 30000 }],
    host: { os: "macos", arch: "arm64", accelerator: "metal", gpuName: "Apple M5 Pro", memoryMb: 49152 },
  });

  assert.ok(text.includes("GPUs : Mac, Apple M5 Pro, Metal (48 GB shared memory)"), text);
  assert.ok(!text.includes("none detected (CPU)"));
});

test("a CUDA backend keeps its VRAM line", () => {
  const text = renderPanel({
    devices: ["cpu", "cuda"],
    gpus: [{ name: "RTX 4090", total_vram_mb: 24564, free_vram_mb: 20480 }],
    host: { os: "windows", arch: "x86_64", accelerator: "cuda", gpuName: "RTX 4090", memoryMb: 24564 },
  });

  assert.ok(text.includes("GPUs : RTX 4090 (20 GB / 24 GB)"), text);
});

test("a Mac backend leaves the CUDA settings out of the request defaults footer", () => {
  const text = renderPanel(
    {
      devices: ["cpu"],
      gpus: [],
      host: { os: "macos", arch: "arm64", accelerator: "metal", gpuName: "Apple M5 Pro", memoryMb: 49152 },
    },
    WINDOWS_SETTINGS,
  );

  assert.ok(text.includes("Current request defaults: small, output SRT."), text);
  assert.ok(!text.includes("cuda"), text);
  assert.ok(!text.includes("float16"), text);
});

test("a CUDA backend keeps the device and compute type in the footer", () => {
  const text = renderPanel(
    {
      devices: ["cpu", "cuda"],
      gpus: [{ name: "RTX 4090", total_vram_mb: 24564, free_vram_mb: 20480 }],
      host: { os: "windows", arch: "x86_64", accelerator: "cuda", gpuName: "RTX 4090", memoryMb: 24564 },
    },
    WINDOWS_SETTINGS,
  );

  assert.ok(text.includes("Current request defaults: small on cuda / float16, output SRT."), text);
});

test("a backend that rejects our token is not reported as ready", () => {
  const text = renderPanel({ devices: ["cpu"] }, {}, false);

  assert.ok(text.includes("Token rejected"), text);
  assert.ok(text.includes("rejected the backend token"), text);
  assert.ok(!text.includes("Ready to transcribe"), text);
});

test("an accepted token, or a backend without one, still reads as ready", () => {
  for (const tokenAccepted of [true, null]) {
    const text = renderPanel({ devices: ["cpu"] }, {}, tokenAccepted);
    assert.ok(text.includes("Ready to transcribe"), text);
    assert.ok(!text.includes("Token rejected"), text);
  }
});
