import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same bootstrap contract as queue-run.test.ts: bind dirs before importing.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-rename-"));
process.env.DATA_DIR = path.join(scratch, "data");
process.env.CONFIG_DIR = path.join(scratch, "config");
process.env.MEDIA_DIR = path.join(scratch, "media");
fs.mkdirSync(process.env.MEDIA_DIR);
const db = await import("./db.js");
const config = await import("./config.js");
const { restoreRedactedApiKeys, parseConnections, resolveConnectionPool, REDACTED_SECRET } = await import("./connections.js");
type LlmConnection = Awaited<ReturnType<typeof import("./connections.js").parseConnections>>[number];
const queue = await import("./queue.js");

(globalThis as any).AI_SDK_LOG_WARNINGS = false;

function chatCompletion(content: string): Response {
  const body = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const release: Array<() => void> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  // The express app under test shares this global; loopback passes through.
  if (url.startsWith("http://127.0.0.1")) return realFetch(input as URL, init);
  if (url.endsWith("/v1/models")) return new Response('{"data":[]}', { status: 200 });
  if (!url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      { once: true },
    );
    release.push(() => resolve(chatCompletion('["translated"]')));
  });
}) as typeof fetch;

async function waitFor(condition: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const conn = (label: string, apiKey: string): LlmConnection => ({
  id: "conn-a", label, provider: "local", apiKey, model: "test-model",
  endpoint: "http://fake.test/v1", enabled: true, order: 0,
});

const taskId = config.createTask({
  source_lang: "Automatic",
  target_lang: "Chinese",
  output_pattern: "{name}.chi.srt",
  lang_code: "chi",
}).lastInsertRowid;

const mediaDir = process.env.MEDIA_DIR;
let jobSeq = 100;
function addJob() {
  jobSeq += 1;
  const srtPath = path.join(mediaDir, `rename-${jobSeq}.srt`);
  const outputPath = path.join(mediaDir, `rename-${jobSeq}.chi.srt`);
  fs.writeFileSync(srtPath, "1\n00:00:01,000 --> 00:00:02,000\nhello\n", "utf8");
  const result = db.createJob({ task_id: taskId, srt_path: srtPath, output_path: outputPath, video_path: null });
  return Number(result.lastInsertRowid);
}

/** Drain the job to a settled state, releasing LLM calls as they arrive. */
async function drain(jobId: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = db.getJob(jobId)?.status;
    if (status !== "translating" && status !== "pending") return status;
    if (release.length > 0) release.shift()!();
    await new Promise((r) => setTimeout(r, 5));
  }
  return "stuck";
}

test("the settings round-trip restores the API key after a rename", () => {
  const stored = [conn("Original", "sk-real")];
  // What the client sends after editing the label: redacted key, same id.
  const posted = JSON.stringify([conn("Renamed", REDACTED_SECRET)]);
  const resolved = restoreRedactedApiKeys(posted, stored);
  const parsed = parseConnections({ llm_connections: resolved });
  assert.equal(parsed[0].label, "Renamed");
  assert.equal(parsed[0].apiKey, "sk-real");
});

test("a renamed connection still resolves as the active single-mode pool", () => {
  config.setSetting("llm_connections", JSON.stringify([conn("Original", "sk-real")]));
  config.setSetting("active_connection_id", "conn-a");
  config.setSetting("llm_mode", "single");
  config.setSetting("llm_connections", JSON.stringify([conn("Renamed", "sk-real")]));
  const { pool } = resolveConnectionPool(config.getAllSettings());
  assert.equal(pool.length, 1);
  assert.equal(pool[0].apiKey, "sk-real");
  assert.equal(pool[0].label, "Renamed");
});

test("renaming the connection mid-run does not break the running job", async () => {
  config.setSetting("disable_tool_calls", "1");
  config.setSetting("llm_connections", JSON.stringify([conn("Original", "")]));
  config.setSetting("active_connection_id", "conn-a");
  config.setSetting("llm_mode", "single");
  config.setSetting("request_timeout_s", "5");

  const job = addJob();
  const run = queue.processQueue();
  await waitFor(() => release.length > 0, "the job to call the LLM");

  // The job is in flight; the user renames the LLM in Settings (id preserved).
  config.setSetting("llm_connections", JSON.stringify([conn("Renamed", "")]));

  const status = await drain(job);
  await run;
  release.length = 0;
  assert.equal(status, "done", `job settled as ${status}: ${db.getJob(job)?.error}`);
  db.deleteJob(job);
});

// ── Full HTTP flow: the exact POST the Settings page sends ──────────────────
const express = (await import("express")).default;
const { registerSettingsTasksRoutes } = await import("./routes/settings-tasks.js");
const app = express();
app.use(express.json());
registerSettingsTasksRoutes(app);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;

async function postSettings(body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; rejected: string[] };
}

test("the real POST /api/settings rename keeps the key and the job pool", async () => {
  // Stored: a connection with a real key, active in single mode. Local provider
  // so the stubbed endpoint serves the post-rename job.
  const stored = [{ id: "conn-a", label: "Original", provider: "local", apiKey: "sk-real", model: "test-model", endpoint: "http://fake.test/v1", enabled: true, order: 0 }];
  config.setSetting("llm_connections", JSON.stringify(stored));
  config.setSetting("active_connection_id", "conn-a");
  config.setSetting("llm_mode", "single");

  // What the client round-trips: the redacted GET copy with only the label edited.
  const body = { llm_connections: JSON.stringify([{ ...stored[0], label: "Renamed", apiKey: REDACTED_SECRET }]) };
  try {
    const result = await postSettings(body);
    assert.deepEqual(result.rejected, []);

    const { pool } = resolveConnectionPool(config.getAllSettings());
    assert.equal(pool[0].label, "Renamed");
    assert.equal(pool[0].apiKey, "sk-real");
    assert.equal(pool[0].model, "test-model");

    // And a job claimed after the rename still gets a usable connection.
    const job = addJob();
    const run = queue.processQueue();
    await waitFor(() => release.length > 0, "the post-rename job to call the LLM");
    const status = await drain(job);
    await run;
    release.length = 0;
    assert.equal(status, "done", `job settled as ${status}: ${db.getJob(job)?.error}`);
    db.deleteJob(job);
  } finally {
    // A failed assert must not leave the express server keeping the runner alive.
    server.closeAllConnections();
    server.close();
  }
});
