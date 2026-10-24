import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// config.ts, usage.ts and convert-batches.ts bind their folders at import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-convert-usage-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = path.join(root, "media");
process.env.CONVERT_BATCH_DIR = path.join(root, "batches");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
const realFetch = globalThis.fetch;
// The LLM: answers every chat completion at once; other endpoints 404 so the context probe falls back.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("http://llm.test")) return realFetch(input, init);
  if (url.endsWith("/v1/models")) return new Response('{"data":[]}', { status: 200 });
  if (!url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
  const body = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content: "Hallo" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { default: express } = await import("express");
const config = await import("../config.js");
const usage = await import("../usage.js");
const { registerConvertBatchRoutes } = await import("./convert-batches.js");

const app = express();
app.use(express.json());
registerConvertBatchRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

test("a Convert translation lands in the usage ledger under its file name", async () => {
  config.setSetting("llm_mode", "single");
  config.setSetting(
    "llm_connections",
    JSON.stringify([
      { id: "gpu", label: "Desk GPU", provider: "local", model: "qwen3-14b", endpoint: "http://llm.test/v1" },
    ]),
  );
  config.setSetting("disable_tool_calls", "1");
  usage.clearUsage();

  const created = await realFetch(`${appUrl}/api/convert/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: [{ name: "talk.srt", content: "1\n00:00:01,000 --> 00:00:02,000\nHello\n", skip: false }],
      targetFormat: "srt",
      translate: true,
      targetLang: "German",
      targetCode: "de",
    }),
  });
  assert.equal(created.status, 202);
  const { id } = (await created.json()) as { id: string };
  const deadline = Date.now() + 10_000;
  let batch: { status: string; files: Array<{ status: string; error?: string }> };
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    batch = await realFetch(`${appUrl}/api/convert/batches/${id}`).then((res) => res.json());
  } while (batch.status !== "done" && Date.now() < deadline);
  assert.equal(batch.files[0].status, "done", batch.files[0].error);

  const { recent } = usage.buildUsageReport("all");
  assert.ok(recent.length > 0, "the translation's LLM calls are recorded");
  assert.ok(recent.every((call) => call.kind === "convert" && call.srtName === "talk.srt" && call.jobId === null));
});
