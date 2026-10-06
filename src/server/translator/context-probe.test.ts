import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { planJobContext, probeModelContext } from "./context-probe.js";

// A stand-in for LM Studio's native /api/v0/models endpoint.
async function lmStudio(models: unknown[]): Promise<{ apiHost: string; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url !== "/api/v0/models") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: models }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { apiHost: `http://127.0.0.1:${port}/v1`, server };
}

test("sizes prompts to the loaded context, not the model's maximum", async () => {
  // LM Studio loaded gemma with 8k of its 262k window; sizing for 262k sent
  // ~52k-token prompts that LM Studio rejected with 400 exceed_context_size_error.
  const { apiHost, server } = await lmStudio([
    { id: "google/gemma-4-26b-a4b-qat", max_context_length: 262144, loaded_context_length: 8192 },
  ]);
  try {
    const info = await probeModelContext(apiHost, "google/gemma-4-26b-a4b-qat");
    assert.equal(info.maxContextTokens, 8192);
    assert.equal(info.recommendedAnalysisLines, 109);
  } finally {
    server.close();
  }
});

test("falls back to the model's maximum when no loaded context is reported", async () => {
  const { apiHost, server } = await lmStudio([
    { id: "qwen/qwen3.8-27b", max_context_length: 32768 },
  ]);
  try {
    const info = await probeModelContext(apiHost, "qwen/qwen3.8-27b");
    assert.equal(info.maxContextTokens, 32768);
    assert.equal(info.recommendedAnalysisLines, 436);
  } finally {
    server.close();
  }
});

test("a job plan probes every connection and caps parallel chunks to fit the primary's window", async () => {
  const { apiHost, server } = await lmStudio([
    { id: "small", max_context_length: 262144, loaded_context_length: 8192 },
    { id: "large", max_context_length: 131072, loaded_context_length: 65536 },
  ]);
  try {
    const plan = await planJobContext(
      [
        { id: "a", label: "a", apiKey: "", apiHost, model: "small" },
        { id: "b", label: "b", apiKey: "", apiHost, model: "large" },
      ],
      { fallbackHost: apiHost, chunkSize: 20, configuredParallel: 4 },
    );

    assert.equal(plan.byConnection.get("a")?.maxContextTokens, 8192);
    assert.equal(plan.byConnection.get("b")?.maxContextTokens, 65536);
    // Concurrent requests share LM Studio's window: 8192 holds three
    // 20-cue requests, so the configured four is capped.
    assert.equal(plan.parallelChunks, 3);
  } finally {
    server.close();
  }
});

test("a job plan keeps the configured parallel chunks when the context is unknown", async () => {
  const plan = await planJobContext(
    [{ id: "cloud", label: "cloud", apiKey: "", apiHost: "", model: "gpt", provider: "openai" }],
    { fallbackHost: "http://127.0.0.1:9/v1", chunkSize: 20, configuredParallel: 4 },
  );

  assert.equal(plan.byConnection.get("cloud")?.maxContextTokens, null);
  assert.equal(plan.parallelChunks, 4);
});
