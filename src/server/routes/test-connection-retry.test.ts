import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// config.ts, db.ts and logger.ts read these at import, so point them at a scratch folder first.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-test-connection-"));
process.env.CONFIG_DIR = path.join(scratch, "config");
process.env.DATA_DIR = path.join(scratch, "data");
process.env.MEDIA_DIR = path.join(scratch, "media");

const { default: express } = await import("express");
const { registerModelsRoutes } = await import("./models.js");
const { streamable } = await import("../translator/streaming-chat-fixture.js");

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

function chatCompletion(content: string, finishReason: string): Response {
  const body = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// A model that reasons until the output limit unless asked for "minimal" effort.
const realFetch = globalThis.fetch;
const llmFetch = streamable((async (_input: string | URL | Request, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
  return request.reasoning_effort === "minimal" ? chatCompletion("你好", "stop") : chatCompletion("", "length");
}) as typeof fetch);
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  return url.startsWith("http://llm.test") ? llmFetch(input, init) : realFetch(input, init);
}) as typeof fetch;

const app = express();
app.use(express.json());
registerModelsRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");

after(() => {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function testConnection(cutOffRetryEffort: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/test-connection`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "local", model: "test-model", endpoint: "http://llm.test/v1", cutOffRetryEffort }),
  });
  return (await res.json()) as { ok: boolean; message: string };
}

test("Test on a connection uses the retry effort selected on its card, saved or not", async () => {
  assert.equal((await testConnection("minimal")).ok, true);
  assert.equal((await testConnection("off")).ok, false);
});
