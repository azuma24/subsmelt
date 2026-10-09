import test from "node:test";
import assert from "node:assert/strict";
import type { UseQueryResult } from "@tanstack/react-query";
import { renderPage } from "../../test-render";
import type { TranscriptionHealth } from "../../types";
import { TranscriptionReadinessPanel } from "./TranscriptionReadinessPanel";

type Capabilities = NonNullable<NonNullable<TranscriptionHealth["health"]>["capabilities"]>;

function renderPanel(capabilities: Capabilities): string {
  const healthQuery = {
    data: { ok: true, endpointReachable: true, health: { ffmpeg: true, capabilities } },
    isLoading: false,
    isFetching: false,
    refetch: () => {},
  } as unknown as UseQueryResult<TranscriptionHealth>;
  const settings = { transcription_enabled: "1", transcription_backend_url: "http://whisper:8001" };
  return renderPage(<TranscriptionReadinessPanel settings={settings} healthQuery={healthQuery} dirty={false} />).text;
}

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
