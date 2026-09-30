import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// queue.ts pulls in db.ts, config.ts and scanner.ts, which bind their
// directories at import, so point all three at scratch folders first.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-queue-"));
process.env.DATA_DIR = path.join(scratch, "data");
process.env.CONFIG_DIR = path.join(scratch, "config");
process.env.MEDIA_DIR = path.join(scratch, "media");
fs.mkdirSync(process.env.MEDIA_DIR);
const db = await import("./db.js");
const config = await import("./config.js");
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

// Chat completions hang until the test releases them; everything else 404s so
// the model-context probe falls back without touching the network.
const release: Array<() => void> = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
  return new Promise<Response>((resolve) => {
    release.push(() => resolve(chatCompletion("Translated Title")));
  });
}) as typeof fetch;

async function waitFor(condition: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const taskId = config.createTask({
  source_lang: "Automatic",
  target_lang: "Chinese",
  output_pattern: "{name}.chi.srt",
  lang_code: "chi",
}).lastInsertRowid;

const mediaDir = process.env.MEDIA_DIR;
let jobSeq = 0;
function addJob(opts: { srtExists: boolean; outputExists: boolean }) {
  jobSeq += 1;
  const srtPath = path.join(mediaDir, `job-${jobSeq}.srt`);
  const outputPath = path.join(mediaDir, `job-${jobSeq}.chi.srt`);
  const cue = "1\n00:00:01,000 --> 00:00:02,000\nhello\n";
  if (opts.srtExists) fs.writeFileSync(srtPath, cue, "utf8");
  if (opts.outputExists) fs.writeFileSync(outputPath, cue, "utf8");
  const result = db.createJob({ task_id: taskId, srt_path: srtPath, output_path: outputPath, video_path: null });
  return Number(result.lastInsertRowid);
}

test("the queue resumes at boot only when auto-translate is on and jobs are pending", () => {
  assert.equal(queue.shouldResumeQueueOnBoot("1", 3), true);
  assert.equal(queue.shouldResumeQueueOnBoot("1", 0), false);
  assert.equal(queue.shouldResumeQueueOnBoot("0", 3), false);
  assert.equal(queue.shouldResumeQueueOnBoot("", 3), false);
});

test("resuming at boot processes the pending jobs a previous process left behind", async () => {
  // A job whose source file is gone fails immediately, which is enough to show
  // the queue picked it up: an unprocessed job would still be pending.
  const orphan = addJob({ srtExists: false, outputExists: false });
  assert.equal(db.getJob(orphan)?.status, "pending");

  queue.resumeQueueOnBoot();
  await waitFor(() => !queue.isQueueRunning(), "the resumed queue run to finish");

  assert.equal(db.getJob(orphan)?.status, "error");
});
