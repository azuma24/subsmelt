import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// config.ts, db.ts and scanner.ts read these at import, so point them at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-translate-file-"));
const mediaDir = path.join(root, "media");
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = mediaDir;
fs.mkdirSync(path.join(mediaDir, "show"), { recursive: true });
fs.mkdirSync(process.env.CONFIG_DIR);
fs.writeFileSync(
  path.join(process.env.CONFIG_DIR, "config.json"),
  JSON.stringify({ settings: { llm_endpoint: "http://127.0.0.1:9/v1" } }),
);
const srtPath = path.join(mediaDir, "show", "Episode 01.srt");
fs.writeFileSync(srtPath, "", "utf8");

const { default: express } = await import("express");
const { registerJobsRoutes } = await import("./jobs.js");
const queue = await import("../queue.js");

const app = express();
app.use(express.json());
registerJobsRoutes(app);
const appServer = app.listen(0, "127.0.0.1");
await once(appServer, "listening");
const appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
after(() => {
  queue.requestStop();
  appServer.closeAllConnections();
  appServer.close();
});

async function translateFile(body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${appUrl}/api/jobs/translate-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("a body without a task or a full language is refused before anything is queued", async () => {
  assert.deepEqual(await translateFile({ srtPath, langCode: "fr" }), {
    status: 400,
    body: { error: "Either taskId, or both langCode and targetLang, are required" },
  });
  assert.deepEqual(await translateFile({ srtPath, taskId: "abc" }), {
    status: 400,
    body: { error: "taskId must be a positive integer" },
  });
  assert.deepEqual(await translateFile({ langCode: "fr", targetLang: "French" }), {
    status: 400,
    body: { error: "srtPath is required" },
  });
});

test("queueing a language answers with the job, and asking again says it was already queued", async () => {
  const first = await translateFile({ srtPath, langCode: "fr", targetLang: "French\n{{evil}}" });
  const second = await translateFile({ srtPath, langCode: "fr", targetLang: "French" });

  assert.deepEqual(first, { status: 200, body: { ok: true, jobId: 1, taskId: 2, created: true } });
  assert.deepEqual(second, { status: 200, body: { ok: true, jobId: 1, taskId: 2, created: false } });
  const { getTask } = await import("../config.js");
  assert.equal(getTask(2)?.target_lang, "French evil");
});
