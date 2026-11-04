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
const runMarker = await import("./queue/run-marker.js");
const usage = await import("./usage.js");

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

// The availability probe passes; chat completions hang until the test releases
// them or the engine aborts them; everything else 404s so the model-context
// probe falls back without touching the network.
const release: Array<(content?: string) => void> = [];
// Hosts that reject requests until a test takes them back out, for a
// connection that fails partway through a job and then recovers.
const failingHosts = new Set<string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/v1/models")) return new Response('{"data":[]}', { status: 200 });
  if (url.includes("broken.test") || failingHosts.has(new URL(url).host))
    return new Response('{"error":"bad request"}', { status: 400 });
  if (!url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
      once: true,
    });
    release.push((content = "Translated Title") => resolve(chatCompletion(content)));
  });
}) as typeof fetch;

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
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

test("a job queued while the run repairs titles is processed by that run", async () => {
  config.setSetting("title_sidecar", "1");
  config.setSetting("disable_tool_calls", "1");
  // Its output already exists, so the queue skips it and then repairs its title
  // with an LLM call that the stubbed fetch holds open.
  addJob({ srtExists: true, outputExists: true });
  const run = queue.processQueue();
  await waitFor(() => release.length > 0, "the title repair to call the LLM");

  // What a watcher scan or a retry does while the repair is in flight.
  const late = addJob({ srtExists: false, outputExists: false });
  await queue.processQueue();
  release.shift()!();
  await run;

  assert.equal(db.getJob(late)?.status, "error");
  config.setSetting("title_sidecar", "0");
});

test("stopping a job returns it to pending with its progress cleared", async () => {
  const job = addJob({ srtExists: true, outputExists: false });
  const run = queue.processQueue();
  await waitFor(() => release.length > 0, "the job to call the LLM");
  // Stands in for a throttled progress tick that landed before the stop.
  db.updateJob(job, { completed_cues: 42 });

  queue.requestStop();
  await run;
  release.length = 0;

  try {
    // The next run starts the file over, so a kept count would show the
    // pending job as part-done.
    assert.deepEqual([db.getJob(job)?.status, db.getJob(job)?.completed_cues], ["pending", 0]);
  } finally {
    // Keep the boot-resume run below from picking this job up and hanging on its LLM call.
    db.deleteJob(job);
  }
});

test("cancelling one translating job ends it as cancelled and the queue continues", async () => {
  const first = addJob({ srtExists: true, outputExists: false });
  const second = addJob({ srtExists: true, outputExists: false });
  const run = queue.processQueue();
  await waitFor(() => release.length > 0, "the first job to call the LLM");

  assert.equal(queue.requestJobCancel(first), true);
  await waitFor(() => db.getJob(first)?.status === "error", "the cancelled job to settle");
  // The freed worker picks up the next pending job instead of stopping.
  await waitFor(() => db.getJob(second)?.status === "translating", "the queue to continue with the next job");

  queue.requestStop();
  await run;
  release.length = 0;

  assert.equal(db.getJob(first)?.error, "Cancelled by user");
  // The settle path must unregister the job: a stale cancel marker would make
  // its next run insta-fail with "Cancelled by user".
  assert.equal(queue.requestJobCancel(first), false);
  db.deleteJob(first);
  db.deleteJob(second);
});

function useConnections(mode: string, connections: object[]) {
  config.setSetting("llm_mode", mode);
  config.setSetting("llm_connections", JSON.stringify(connections));
}

function resetConnections() {
  config.setSetting("llm_mode", "");
  config.setSetting("llm_connections", "");
}

test("a translating job reports the connection and model running it", async () => {
  useConnections("single", [
    {
      id: "gpu",
      label: "Local 4090",
      provider: "local",
      model: "Qwen/Qwen2.5-72B-Instruct",
      endpoint: "http://gpu.test/v1",
    },
  ]);
  const job = addJob({ srtExists: true, outputExists: false });
  const run = queue.processQueue();
  try {
    await waitFor(() => release.length > 0, "the job to call the LLM");

    const expected = { id: "gpu", label: "Local 4090", host: "http://gpu.test/v1", model: "Qwen/Qwen2.5-72B-Instruct" };
    assert.deepEqual(queue.getJobConnection(job), expected);
    assert.deepEqual(queue.getActiveJobConnections(), [{ jobId: job, ...expected }]);
  } finally {
    queue.requestStop();
    await run;
    release.length = 0;
    resetConnections();
  }

  assert.equal(queue.getJobConnection(job), null);
  db.deleteJob(job);
});

test("every LLM call a job makes lands in the usage ledger with its model and file", async () => {
  useConnections("single", [
    { id: "gpu", label: "Local 4090", provider: "local", model: "qwen3-14b", endpoint: "http://gpu.test/v1" },
  ]);
  usage.clearUsage();
  const job = addJob({ srtExists: true, outputExists: false });
  const run = queue.processQueue();
  try {
    await waitFor(() => {
      for (const answer of release.splice(0)) answer("你好");
      return db.getJob(job)?.status === "done";
    }, "the job to finish");
  } finally {
    queue.requestStop();
    await run;
    release.length = 0;
    resetConnections();
  }

  const { recent, byModel } = usage.buildUsageReport("all");
  assert.ok(recent.length > 0);
  assert.ok(
    recent.every((call) => call.jobId === job && call.srtName === `job-${jobSeq}.srt` && call.model === "qwen3-14b"),
  );
  assert.deepEqual(
    byModel.map((m) => [m.provider, m.model, m.connectionLabel, m.costUsd]),
    [["local", "qwen3-14b", "Local 4090", null]],
  );
  assert.equal(db.getJob(job)?.input_tokens, recent.length);
  db.deleteJob(job);
});

test("a fallback switch mid-job reports the model of the connection that took over", async () => {
  useConnections("fallback", [
    {
      id: "broken",
      label: "Desk GPU",
      provider: "local",
      model: "llama-3.1-8b",
      endpoint: "http://broken.test/v1",
      order: 0,
    },
    {
      id: "backup",
      label: "Spare box",
      provider: "local",
      model: "gemma-2-27b",
      endpoint: "http://backup.test/v1",
      order: 1,
    },
  ]);
  // Two one-cue chunks keep the job translating after the first chunk switches over.
  config.setSetting("chunk_size", "1");
  const job = addJob({ srtExists: true, outputExists: false });
  const twoCues = "1\n00:00:01,000 --> 00:00:02,000\nhello\n\n2\n00:00:03,000 --> 00:00:04,000\nbye\n";
  fs.writeFileSync(db.getJob(job)!.srt_path, twoCues, "utf8");
  const run = queue.processQueue();
  try {
    // The primary rejects every request, so the first chunk fails over to the backup.
    await waitFor(() => release.length > 0, "the backup to call the LLM");
    release.shift()!('["hola"]');
    await waitFor(() => queue.getJobConnection(job)?.label === "Spare box", "the job to switch connections");

    assert.deepEqual(queue.getJobConnection(job), {
      id: "backup",
      label: "Spare box",
      host: "http://backup.test/v1",
      model: "gemma-2-27b",
    });
  } finally {
    queue.requestStop();
    await run;
    release.length = 0;
    resetConnections();
    config.setSetting("chunk_size", "");
  }
  db.deleteJob(job);
});

test("a job that falls back and then recovers reports the primary's model again", async () => {
  useConnections("fallback", [
    {
      id: "flaky",
      label: "Desk GPU",
      provider: "local",
      model: "llama-3.1-8b",
      endpoint: "http://flaky.test/v1",
      order: 0,
    },
    {
      id: "backup",
      label: "Spare box",
      provider: "local",
      model: "gemma-2-27b",
      endpoint: "http://backup.test/v1",
      order: 1,
    },
  ]);
  config.setSetting("chunk_size", "1");
  const job = addJob({ srtExists: true, outputExists: false });
  const fourCues =
    "1\n00:00:01,000 --> 00:00:02,000\none\n\n2\n00:00:03,000 --> 00:00:04,000\ntwo\n\n3\n00:00:05,000 --> 00:00:06,000\nthree\n\n4\n00:00:07,000 --> 00:00:08,000\nfour\n";
  fs.writeFileSync(db.getJob(job)!.srt_path, fourCues, "utf8");
  const run = queue.processQueue();
  const primary = { id: "flaky", label: "Desk GPU", host: "http://flaky.test/v1", model: "llama-3.1-8b" };
  try {
    // The primary answers the context analysis, rejects the first chunk, then recovers.
    await waitFor(() => release.length > 0, "the primary to call the LLM");
    failingHosts.add("flaky.test");
    release.shift()!("context");
    await waitFor(() => release.length > 0, "the backup to take over");
    failingHosts.delete("flaky.test");
    release.shift()!('["uno"]');
    await waitFor(() => queue.getJobConnection(job)?.label === "Spare box", "the job to switch to the backup");

    await waitFor(() => release.length > 0, "the primary to call the LLM again");
    release.shift()!('["dos"]');
    await waitFor(() => queue.getJobConnection(job)?.label === "Desk GPU", "the job to switch back to the primary");

    assert.deepEqual(queue.getJobConnection(job), primary);
  } finally {
    failingHosts.clear();
    queue.requestStop();
    await run;
    release.length = 0;
    resetConnections();
    config.setSetting("chunk_size", "");
  }
  db.deleteJob(job);
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

test("with auto-translate off, boot resumes only the run the previous process died during", async () => {
  config.setSetting("auto_translate", "0");
  const selected = addJob({ srtExists: true, outputExists: false });
  const untouched = addJob({ srtExists: false, outputExists: false });
  try {
    const run = queue.processQueue([selected]);
    await waitFor(() => release.length > 0, "the selected job to call the LLM");
    // The process dies here: nothing ends the run, and the next process's
    // startup puts the translating job back to pending.
    const interrupted = runMarker.interruptedQueueRun();
    queue.requestStop();
    await run;
    release.length = 0;
    assert.deepEqual(interrupted, { ids: [selected] });
    assert.equal(runMarker.interruptedQueueRun(), null, "a finished or stopped run leaves nothing to resume");

    // A stopped job goes back to pending, as startup does to a translating one.
    assert.equal(db.getJob(selected)?.status, "pending");
    fs.rmSync(db.getJob(selected)!.srt_path, { force: true });
    runMarker.markQueueRun(interrupted?.ids ?? undefined);
    queue.resumeQueueOnBoot();
    await waitFor(() => !queue.isQueueRunning(), "the resumed queue run to finish");

    // Processed: its now-missing source fails it.
    assert.equal(db.getJob(selected)?.status, "error");
    assert.equal(db.getJob(untouched)?.status, "pending");
    assert.equal(runMarker.interruptedQueueRun(), null);
  } finally {
    config.setSetting("auto_translate", "1");
    db.deleteJob(selected);
    db.deleteJob(untouched);
  }
});

test("with auto-translate off and no interrupted run, boot leaves pending jobs alone", () => {
  config.setSetting("auto_translate", "0");
  const pending = addJob({ srtExists: false, outputExists: false });
  try {
    queue.resumeQueueOnBoot();
    assert.equal(queue.isQueueRunning(), false);
    assert.equal(db.getJob(pending)?.status, "pending");
  } finally {
    config.setSetting("auto_translate", "1");
    db.deleteJob(pending);
  }
});

test("a run asked for while a run of selected jobs is active starts when that run ends", async () => {
  const selected = addJob({ srtExists: true, outputExists: false });
  const run = queue.processQueue([selected]);
  await waitFor(() => release.length > 0, "the selected job to call the LLM");

  // What a retry, a watcher scan or a one-off translation does meanwhile.
  const later = addJob({ srtExists: false, outputExists: false });
  await queue.processQueue();
  assert.equal(db.getJob(later)?.status, "pending");

  queue.requestJobCancel(selected);
  await run;
  release.length = 0;
  assert.equal(db.getJob(selected)?.status, "error");
  // Processed by the same run: its missing source fails it.
  assert.equal(db.getJob(later)?.status, "error");
  assert.equal(queue.isQueueRunning(), false);
  db.deleteJob(selected);
  db.deleteJob(later);
});

const koreanTaskId = config.createTask({
  source_lang: "Automatic",
  target_lang: "Korean",
  output_pattern: "{{name}}.{{lang_code}}.srt",
  lang_code: "kor",
}).lastInsertRowid;

function addKoreanJob(name: string, outputName: string, existing: string[]): number {
  const cue = "1\n00:00:01,000 --> 00:00:02,000\nhello\n";
  fs.writeFileSync(path.join(mediaDir, `${name}.en.srt`), cue, "utf8");
  for (const file of existing) fs.writeFileSync(path.join(mediaDir, file), cue, "utf8");
  return Number(
    db.createJob({
      task_id: koreanTaskId,
      srt_path: path.join(mediaDir, `${name}.en.srt`),
      output_path: path.join(mediaDir, outputName),
      video_path: null,
    }).lastInsertRowid,
  );
}

test("a job skipped because its output exists in an old spelling points at that file", async () => {
  const job = addKoreanJob("Old", "Old.kor.srt", ["Old.ko.srt"]);
  await queue.processQueue([job]);
  assert.deepEqual(
    { status: db.getJob(job)?.status, output: db.getJob(job)?.output_path },
    { status: "skipped", output: path.join(mediaDir, "Old.ko.srt") },
  );
  db.deleteJob(job);
});

test("re-translating an output written in an old spelling replaces that file instead of adding a second one", async () => {
  const job = addKoreanJob("Again", "Again.ko.srt", ["Again.ko.srt"]);
  db.forceJob(job);
  const run = queue.processQueue([job]);
  while (db.getJob(job)?.status !== "done") {
    await waitFor(
      () => release.length > 0 || db.getJob(job)?.status === "done" || db.getJob(job)?.status === "error",
      "the job to call the LLM or finish",
    );
    assert.notEqual(db.getJob(job)?.status, "error", db.getJob(job)?.error ?? "");
    release.shift()?.('["안녕"]');
  }
  await run;
  assert.equal(db.getJob(job)?.output_path, path.join(mediaDir, "Again.ko.srt"));
  assert.match(fs.readFileSync(path.join(mediaDir, "Again.ko.srt"), "utf8"), /안녕/);
  assert.equal(fs.existsSync(path.join(mediaDir, "Again.kor.srt")), false);
  db.deleteJob(job);
});

// ── Split one file across connections (llm_split_file) ───────────────────────
// The module-level stub answers every chat request with a held promise and a
// fixed title, which does not fit these tests: they need per-host routing,
// peak-concurrency control and per-cue translations. Each installs its own
// stub and restores the module stub afterwards.

const moduleFetch = globalThis.fetch;

interface SplitInfo {
  host: string;
  kind: "analysis" | "chunk";
  lines: string[];
}

function splitRequestInfo(input: string | URL | Request, init?: RequestInit): SplitInfo {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const body = JSON.parse(String(init?.body ?? "{}"));
  const system = String(body.messages?.find((m: any) => m.role === "system")?.content ?? "");
  const user = String(body.messages?.find((m: any) => m.role === "user")?.content ?? "");
  if (system.includes("subtitle content analyst")) return { host: url.host, kind: "analysis", lines: [] };
  const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
  return { host: url.host, kind: "chunk", lines };
}

function useSplitFetch(
  t: { after(fn: () => void): void },
  chat: (info: SplitInfo, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response('{"data":[]}', { status: 200 });
    if (!url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
    return chat(splitRequestInfo(input, init), init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = moduleFetch;
  });
}

function splitSrt(cues: number): string {
  return Array.from({ length: cues }, (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:01,500\ncue ${i + 1}\n`).join("\n");
}

function srtCueTexts(srt: string): string[] {
  return srt
    .trim()
    .split(/\n\n+/)
    .map((block) => block.split("\n").slice(2).join("\n").trim());
}

/** The output must read `Z-<source>` for every cue, in the source file's order. */
function assertCuesTranslatedInOrder(srt: string, cues: number) {
  assert.deepEqual(
    srtCueTexts(srt),
    Array.from({ length: cues }, (_, i) => `Z-cue ${i + 1}`),
  );
}

function useParallelConnections(firstEndpoint: string, secondEndpoint: string) {
  useConnections("parallel", [
    { id: "a", label: "Host A", provider: "local", model: "m", endpoint: firstEndpoint, order: 0 },
    { id: "b", label: "Host B", provider: "local", model: "m", endpoint: secondEndpoint, order: 1 },
  ]);
  config.setSetting("disable_tool_calls", "1");
}

test("split mode serves one file's chunks from every connection, in source order", async (t) => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("llm_split_file", "1");
  config.setSetting("chunk_size", "1");
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(6), "utf8");
  const chunkHosts = new Set<string>();
  useSplitFetch(t, (info) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    chunkHosts.add(info.host);
    return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
  });
  const run = queue.processQueue();
  try {
    await waitFor(() => ["done", "error"].includes(db.getJob(job)?.status ?? ""), "the job to settle", 15_000);
    await run;
    assert.equal(db.getJob(job)?.status, "done", db.getJob(job)?.error ?? "");
    assert.deepEqual([...chunkHosts].sort(), ["a.test", "b.test"], "both hosts served chunks of the one job");
    assert.deepEqual(
      (db.getJob(job)?.used_connections ?? "").split(", ").sort(),
      ["Host A", "Host B"],
      "both connections are credited for the job",
    );
    assertCuesTranslatedInOrder(fs.readFileSync(db.getJob(job)!.output_path, "utf8"), 6);
  } finally {
    queue.requestStop();
    await run;
    config.setSetting("llm_split_file", "0");
    config.setSetting("chunk_size", "");
    db.deleteJob(job);
  }
});

test("without the flag, a parallel-mode job's chunks all come from one host", async (t) => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("chunk_size", "1");
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(6), "utf8");
  const chunkHosts = new Set<string>();
  useSplitFetch(t, (info) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    chunkHosts.add(info.host);
    return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
  });
  const run = queue.processQueue();
  try {
    await waitFor(() => ["done", "error"].includes(db.getJob(job)?.status ?? ""), "the job to settle", 15_000);
    await run;
    assert.equal(db.getJob(job)?.status, "done", db.getJob(job)?.error ?? "");
    assert.equal(chunkHosts.size, 1, `the whole file ran on one host, saw ${[...chunkHosts].join(", ")}`);
    assertCuesTranslatedInOrder(fs.readFileSync(db.getJob(job)!.output_path, "utf8"), 6);
  } finally {
    queue.requestStop();
    await run;
    config.setSetting("chunk_size", "");
    db.deleteJob(job);
  }
});

test("split mode runs parallel_chunks × connections chunk workers at once", async (t) => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("llm_split_file", "1");
  config.setSetting("chunk_size", "1");
  config.setSetting("parallel_chunks", "2");
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(8), "utf8");
  let inFlight = 0;
  let peak = 0;
  const held: Array<() => void> = [];
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  useSplitFetch(t, (info, init) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    inFlight++;
    peak = Math.max(peak, inFlight);
    const content = JSON.stringify(info.lines.map((l) => `Z-${l}`));
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
      const finish = () => {
        inFlight--;
        resolve(chatCompletion(content));
      };
      held.push(finish);
      releaseTimer ??= setTimeout(() => {
        timedOut = true;
        for (const f of held.splice(0)) f();
      }, 8_000);
      if (timedOut || inFlight >= 4) {
        clearTimeout(releaseTimer);
        releaseTimer = undefined;
        for (const f of held.splice(0)) f();
      }
    });
  });
  const run = queue.processQueue();
  try {
    await waitFor(() => ["done", "error"].includes(db.getJob(job)?.status ?? ""), "the job to settle", 20_000);
    await run;
    assert.equal(db.getJob(job)?.status, "done", db.getJob(job)?.error ?? "");
    assert.equal(peak, 4, `peak in-flight chunk requests across both hosts, saw ${peak}`);
  } finally {
    clearTimeout(releaseTimer);
    queue.requestStop();
    await run;
    config.setSetting("llm_split_file", "0");
    config.setSetting("chunk_size", "");
    config.setSetting("parallel_chunks", "");
    db.deleteJob(job);
  }
});

test("split mode caps a surviving host at parallel_chunks in-flight requests", async (t) => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("llm_split_file", "1");
  config.setSetting("chunk_size", "1");
  config.setSetting("parallel_chunks", "2");
  const job = addJob({ srtExists: true, outputExists: false });
  // Enough chunks that the surviving host is still mid-file when the lost
  // machine's workers cascade onto it: its two own workers alone need well
  // over the ~1s the dead host's retry backoff delays the cascade.
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(120), "utf8");
  let inFlight = 0;
  let peak = 0;
  useSplitFetch(t, async (info) => {
    if (info.host === "a.test") return Promise.reject(new Error("ECONNREFUSED"));
    if (info.kind === "analysis") return chatCompletion("Summary.");
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 100));
    inFlight--;
    return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
  });
  const run = queue.processQueue();
  try {
    await waitFor(() => ["done", "error"].includes(db.getJob(job)?.status ?? ""), "the job to settle", 20_000);
    await run;
    assert.equal(db.getJob(job)?.status, "done", db.getJob(job)?.error ?? "");
    assert.equal(peak, 2, `peak in-flight chunk requests on the surviving host, saw ${peak}`);
    assertCuesTranslatedInOrder(fs.readFileSync(db.getJob(job)!.output_path, "utf8"), 120);
  } finally {
    queue.requestStop();
    await run;
    config.setSetting("llm_split_file", "0");
    config.setSetting("chunk_size", "");
    config.setSetting("parallel_chunks", "");
    db.deleteJob(job);
  }
});

test("split mode finishes a job when one connection answers every chat request with an error", async (t) => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("llm_split_file", "1");
  config.setSetting("chunk_size", "1");
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(6), "utf8");
  const chunkOkHosts = new Set<string>();
  useSplitFetch(t, (info) => {
    if (info.kind === "analysis")
      return info.host === "a.test"
        ? new Response('{"error":"bad request"}', { status: 400 })
        : chatCompletion("Summary.");
    if (info.host === "a.test") return new Response('{"error":"bad request"}', { status: 400 });
    chunkOkHosts.add(info.host);
    return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
  });
  const run = queue.processQueue();
  try {
    await waitFor(() => ["done", "error"].includes(db.getJob(job)?.status ?? ""), "the job to settle", 15_000);
    await run;
    assert.equal(db.getJob(job)?.status, "done", db.getJob(job)?.error ?? "");
    assert.deepEqual([...chunkOkHosts], ["b.test"], "the surviving host served every chunk");
    assertCuesTranslatedInOrder(fs.readFileSync(db.getJob(job)!.output_path, "utf8"), 6);
  } finally {
    queue.requestStop();
    await run;
    config.setSetting("llm_split_file", "0");
    config.setSetting("chunk_size", "");
    db.deleteJob(job);
  }
});

test("split mode survives a connection dying mid-file and finishes on the survivor", async (t) => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("llm_split_file", "1");
  config.setSetting("chunk_size", "1");
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(8), "utf8");
  // Host A answers its first two chat requests (the analysis and its first
  // chunk), then every later request dies like a machine lost mid-file.
  const aRequests: string[] = [];
  const chunkOkByHost = new Map<string, number>([
    ["a.test", 0],
    ["b.test", 0],
  ]);
  useSplitFetch(t, (info) => {
    if (info.host === "b.test") {
      if (info.kind === "analysis") return chatCompletion("Summary.");
      chunkOkByHost.set("b.test", (chunkOkByHost.get("b.test") ?? 0) + 1);
      return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
    }
    aRequests.push(info.kind);
    if (aRequests.length <= 2) {
      if (info.kind === "analysis") return chatCompletion("Summary.");
      chunkOkByHost.set("a.test", (chunkOkByHost.get("a.test") ?? 0) + 1);
      return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
    }
    return Promise.reject(new Error("ECONNREFUSED"));
  });
  const run = queue.processQueue();
  try {
    await waitFor(() => ["done", "error"].includes(db.getJob(job)?.status ?? ""), "the job to settle", 20_000);
    await run;
    assert.equal(db.getJob(job)?.status, "done", db.getJob(job)?.error ?? "");
    assertCuesTranslatedInOrder(fs.readFileSync(db.getJob(job)!.output_path, "utf8"), 8);
    assert.deepEqual(
      [...chunkOkByHost],
      [
        ["a.test", 1],
        ["b.test", 7],
      ],
      "the survivor served every chunk after the first",
    );
  } finally {
    queue.requestStop();
    await run;
    config.setSetting("llm_split_file", "0");
    config.setSetting("chunk_size", "");
    db.deleteJob(job);
  }
});
