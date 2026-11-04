import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// queue.ts pulls in db.ts, config.ts and scanner.ts, which bind their
// directories at import, so point all three at scratch folders first.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-queue-split-"));
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

function useConnections(mode: string, connections: object[]) {
  config.setSetting("llm_mode", mode);
  config.setSetting("llm_connections", JSON.stringify(connections));
}

// ── Split one file across connections (llm_split_file) ───────────────────────
// These tests need per-host routing, peak-concurrency control and per-cue
// translations, so each installs its own fetch stub and restores the default
// afterwards.

// Each test installs its own stub; anything outside one must not reach the network.
const moduleFetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
globalThis.fetch = moduleFetch;

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

// ── Hedging a stalled chunk to another machine (llm_split_file) ─────────────

interface StuckCall {
  host: string;
  aborted: boolean;
  answer: (content: string) => void;
}

function hostTag(host: string): string {
  return host === "a.test" ? "A" : "B";
}

function useStalledChunkFetch(
  t: { after(fn: () => void): void },
  stuckLine: string,
  duplicate: (call: StuckCall) => Response | Promise<Response>,
) {
  const original = { call: null as StuckCall | null };
  const duplicates: StuckCall[] = [];
  useSplitFetch(t, (info, init) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    if (!info.lines.includes(stuckLine)) {
      return chatCompletion(JSON.stringify(info.lines.map((l) => `${hostTag(info.host)}-${l}`)));
    }
    const call: StuckCall = { host: info.host, aborted: false, answer: () => {} };
    return new Promise<Response>((resolve, reject) => {
      call.answer = (content) => resolve(chatCompletion(content));
      init?.signal?.addEventListener(
        "abort",
        () => {
          call.aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
      if (original.call) {
        duplicates.push(call);
        Promise.resolve()
          .then(() => duplicate(call))
          .then(resolve, reject);
        return;
      }
      original.call = call;
    });
  });
  return { original, duplicates };
}

const hedgeSettings = () => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("llm_split_file", "1");
  config.setSetting("chunk_size", "1");
  config.setSetting("parallel_chunks", "1");
};

const clearHedgeSettings = () => {
  config.setSetting("llm_split_file", "0");
  config.setSetting("chunk_size", "");
  config.setSetting("parallel_chunks", "");
};

test("split mode hedges a stalled chunk to another connection and the first answer wins", async (t) => {
  hedgeSettings();
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(2), "utf8");
  const calls = useStalledChunkFetch(t, "cue 2", (call) =>
    chatCompletion(JSON.stringify([`${hostTag(call.host)}-cue 2`])),
  );
  const run = queue.processQueue();
  try {
    await waitFor(() => ["done", "error"].includes(db.getJob(job)?.status ?? ""), "the job to settle", 30_000);
    await run;
    assert.equal(db.getJob(job)?.status, "done", db.getJob(job)?.error ?? "");
    assert.equal(db.getJob(job)?.completed_cues, 2);
    assert.deepEqual(srtCueTexts(fs.readFileSync(db.getJob(job)!.output_path, "utf8")), ["A-cue 1", "A-cue 2"]);
    assert.equal(calls.duplicates.length, 1, "exactly one duplicate was sent for the stalled chunk");
    assert.equal(calls.original.call?.aborted, true, "the stuck request was terminated");
  } finally {
    queue.requestStop();
    await run;
    clearHedgeSettings();
    db.deleteJob(job);
  }
});

test("a stop during a stalled chunk ends the run promptly instead of hanging", async (t) => {
  hedgeSettings();
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(2), "utf8");
  const calls = useStalledChunkFetch(t, "cue 2", () => new Promise<Response>(() => {}));
  const run = queue.processQueue();
  let ended = false;
  void run.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  try {
    await waitFor(() => calls.original.call !== null, "the chunk request to stall", 30_000);
    queue.requestStop();
    await waitFor(() => ended, "the run to end promptly", 15_000);
    await run;
    assert.equal(db.getJob(job)?.status, "pending");
  } finally {
    queue.requestStop();
    await run;
    clearHedgeSettings();
    db.deleteJob(job);
  }
});

/** Sorts chat requests into chunks (translated by echo) and anything else, such as a title. */
function useRawChat(
  t: { after(fn: () => void): void },
  first: (host: string, system: string) => Response | null,
  titleHosts: string[],
) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/models")) return new Response('{"data":[]}', { status: 200 });
    if (!url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const system = String(body.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "");
    const user = String(body.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "");
    const isTitle = !user.includes("cue ");
    if (isTitle) titleHosts.push(url.hostname);
    const answer = first(url.hostname, system);
    if (answer) return answer;
    if (isTitle) return chatCompletion("Translated Title");
    await new Promise((r) => setTimeout(r, 200));
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    return chatCompletion(JSON.stringify(lines.map((l) => `Z-${l}`)));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = moduleFetch;
  });
}

function useHoldingFetch(t: { after(fn: () => void): void }) {
  const held: { host: string; answer: () => void }[] = [];
  useSplitFetch(t, (info, init) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
      held.push({
        host: info.host,
        answer: () => resolve(chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)))),
      });
    });
  });
  return held;
}

const answerAllUntil = async (held: { answer: () => void }[], done: () => boolean) => {
  while (!done()) {
    for (const call of held.splice(0)) call.answer();
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("with the flag off, Parallel on one connection is not split and has no idle wait", async (t) => {
  useConnections("parallel", [
    { id: "a", label: "Host A", provider: "local", model: "m", endpoint: "http://a.test/v1", order: 0 },
  ]);
  config.setSetting("disable_tool_calls", "1");
  config.setSetting("chunk_size", "1");
  config.setSetting("parallel_chunks", "2");
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(4), "utf8");
  useSplitFetch(t, (info) =>
    info.kind === "analysis"
      ? chatCompletion("Summary.")
      : chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`))),
  );
  try {
    await queue.processQueue();
    assert.equal(db.getJob(job)?.status, "done");
    assert.ok((db.getJob(job)?.duration_seconds ?? Infinity) < 0.8, `took ${db.getJob(job)?.duration_seconds}s`);
    assertCuesTranslatedInOrder(fs.readFileSync(db.getJob(job)!.output_path, "utf8"), 4);
  } finally {
    clearHedgeSettings();
    db.deleteJob(job);
  }
});

test("a split file does not wait out the idle poll once its last chunk is done", async (t) => {
  hedgeSettings();
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(2), "utf8");
  useSplitFetch(t, (info) =>
    info.kind === "analysis"
      ? chatCompletion("Summary.")
      : chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`))),
  );
  try {
    await queue.processQueue();
    assert.equal(db.getJob(job)?.status, "done");
    assert.ok((db.getJob(job)?.duration_seconds ?? Infinity) < 0.8, `took ${db.getJob(job)?.duration_seconds}s`);
  } finally {
    clearHedgeSettings();
    db.deleteJob(job);
  }
});

test("split files run one at a time", async (t) => {
  hedgeSettings();
  const first = addJob({ srtExists: true, outputExists: false });
  const second = addJob({ srtExists: true, outputExists: false });
  const held = useHoldingFetch(t);
  const run = queue.processQueue();
  try {
    await waitFor(() => held.length >= 1, "the first file to call the LLM");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual([db.getJob(first)?.status, db.getJob(second)?.status], ["translating", "pending"]);
    await answerAllUntil(held, () => db.getJob(second)?.status === "done");
    await run;
    assert.deepEqual([db.getJob(first)?.status, db.getJob(second)?.status], ["done", "done"]);
  } finally {
    clearHedgeSettings();
    db.deleteJob(first);
    db.deleteJob(second);
  }
});

test("a split job reports every connection and keeps its primary", async (t) => {
  hedgeSettings();
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(4), "utf8");
  const held = useHoldingFetch(t);
  const run = queue.processQueue();
  try {
    await waitFor(() => held.length >= 2, "both connections to get a chunk");
    assert.deepEqual(
      queue.getActiveJobConnections().map((c) => [c.jobId, c.id]),
      [
        [job, "a"],
        [job, "b"],
      ],
    );
    const onB = held.splice(
      held.findIndex((call) => call.host === "b.test"),
      1,
    )[0];
    onB.answer();
    await waitFor(() => held.some((call) => call.host === "b.test"), "b's next chunk");
    // b has just answered last, which would move a single-connection job to b.
    assert.equal(queue.getJobConnection(job)?.id, "a");
    await answerAllUntil(held, () => db.getJob(job)?.status === "done");
    await run;
  } finally {
    clearHedgeSettings();
    db.deleteJob(job);
  }
});

test("turning split on mid-run waits for the files already running", async (t) => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("chunk_size", "1");
  const first = addJob({ srtExists: true, outputExists: false });
  const second = addJob({ srtExists: true, outputExists: false });
  const third = addJob({ srtExists: true, outputExists: false });
  const held = useHoldingFetch(t);
  const run = queue.processQueue();
  try {
    await waitFor(() => held.length >= 2, "both files to call the LLM");
    config.setSetting("llm_split_file", "1");
    const running = held.splice(0);
    const firstHost = running[0];
    firstHost.answer();
    await waitFor(() => [first, second].some((id) => db.getJob(id)?.status === "done"), "one file to finish");
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(db.getJob(third)?.status, "pending", "the split file must not start beside a running file");
    for (const call of running.slice(1)) call.answer();
    await answerAllUntil(held, () => db.getJob(third)?.status === "done");
    await run;
  } finally {
    clearHedgeSettings();
    db.deleteJob(first);
    db.deleteJob(second);
    db.deleteJob(third);
  }
});

test("turning split off mid-file starts no other file until it ends", async (t) => {
  hedgeSettings();
  const first = addJob({ srtExists: true, outputExists: false });
  const second = addJob({ srtExists: true, outputExists: false });
  const held = useHoldingFetch(t);
  const run = queue.processQueue();
  try {
    await waitFor(() => held.length >= 1, "the file to call the LLM");
    config.setSetting("llm_split_file", "0");
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(db.getJob(second)?.status, "pending");
    await answerAllUntil(held, () => db.getJob(second)?.status === "done");
    await run;
  } finally {
    clearHedgeSettings();
    db.deleteJob(first);
    db.deleteJob(second);
  }
});

test("cancelling a split job ends it as cancelled", async (t) => {
  hedgeSettings();
  const job = addJob({ srtExists: true, outputExists: false });
  const held = useHoldingFetch(t);
  const run = queue.processQueue();
  try {
    await waitFor(() => held.length >= 1, "the job to call the LLM");
    assert.equal(queue.requestJobCancel(job), true);
    await run;
    assert.deepEqual([db.getJob(job)?.status, db.getJob(job)?.error], ["error", "Cancelled by user"]);
  } finally {
    clearHedgeSettings();
    db.deleteJob(job);
  }
});

test("a primary that takes a lost machine's workers stays at parallel_chunks requests", async (t) => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("llm_split_file", "1");
  config.setSetting("chunk_size", "1");
  config.setSetting("parallel_chunks", "2");
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(120), "utf8");
  let inFlight = 0;
  let peak = 0;
  useSplitFetch(t, async (info) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    if (info.host === "b.test") throw new Error("ECONNREFUSED");
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 100));
    inFlight -= 1;
    return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
  });
  try {
    await queue.processQueue();
    assert.equal(db.getJob(job)?.status, "done");
    assert.equal(peak, 2, "peak in-flight chunk requests on the primary");
  } finally {
    clearHedgeSettings();
    db.deleteJob(job);
  }
});

for (const [mode, split] of [
  ["split", "1"],
  ["single", "0"],
  ["fallback", "0"],
  ["parallel", "0"],
] as const) {
  test(`a job queued just after the claiming worker left is still picked up (${mode})`, async (t) => {
    useConnections(mode === "split" ? "parallel" : mode, [
      { id: "a", label: "Host A", provider: "local", model: "m", endpoint: "http://a.test/v1", order: 0 },
      { id: "b", label: "Host B", provider: "local", model: "m", endpoint: "http://b.test/v1", order: 1 },
    ]);
    config.setSetting("disable_tool_calls", "1");
    config.setSetting("llm_split_file", split);
    const first = addJob({ srtExists: true, outputExists: false });
    useSplitFetch(t, (info) =>
      info.kind === "analysis"
        ? chatCompletion("Summary.")
        : chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`))),
    );
    const run = queue.processQueue();
    let second = 0;
    try {
      await waitFor(() => db.getJob(first)?.status === "done", "the first file");
      await new Promise((r) => setTimeout(r, 5));
      second = addJob({ srtExists: true, outputExists: false });
      await queue.processQueue();
      await waitFor(() => db.getJob(second)?.status === "done", "the job queued late", 7_000);
      await run;
    } finally {
      queue.requestStop();
      await run;
      clearHedgeSettings();
      db.deleteJob(first);
      if (second) db.deleteJob(second);
    }
  });
}

test("a lost machine leaves a split job's reported connections", async (t) => {
  hedgeSettings();
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(30), "utf8");
  useSplitFetch(t, async (info) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    if (info.host === "a.test") throw new Error("ECONNREFUSED");
    await new Promise((r) => setTimeout(r, 200));
    return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
  });
  const run = queue.processQueue();
  try {
    await waitFor(
      () => queue.getActiveJobConnections().filter((c) => c.jobId === job).length === 1,
      "the lost machine to leave",
      10_000,
    );
    assert.deepEqual([queue.getActiveJobConnections()[0].id, queue.getJobConnection(job)?.id], ["b", "b"]);
    await run;
    assert.equal(db.getJob(job)?.status, "done");
  } finally {
    queue.requestStop();
    await run;
    clearHedgeSettings();
    db.deleteJob(job);
  }
});

test("in parallel without split, a late file never pairs with a connection still in use", async (t) => {
  useConnections(
    "parallel",
    ["a", "b", "c"].map((id, order) => ({
      id,
      label: id,
      provider: "local",
      model: "m",
      endpoint: `http://${id}.test/v1`,
      order,
    })),
  );
  config.setSetting("disable_tool_calls", "1");
  const jobs = [1, 2, 3].map(() => addJob({ srtExists: true, outputExists: false }));
  const held = useHoldingFetch(t);
  const run = queue.processQueue();
  let late = 0;
  try {
    await waitFor(() => held.length >= 3, "three files on three connections");
    const take = (host: string) =>
      held.splice(
        held.findIndex((call) => call.host === host),
        1,
      )[0];
    take("a.test").answer();
    await waitFor(() => jobs.filter((id) => db.getJob(id)?.status === "done").length === 1, "the file on a");
    await new Promise((r) => setTimeout(r, 20));
    late = addJob({ srtExists: true, outputExists: false });
    await queue.processQueue();
    take("c.test").answer();
    await waitFor(() => held.length >= 2, "the late file's request", 2_000);
    assert.equal(held.at(-1)?.host, "c.test", "c is free; b is still in use");
    await answerAllUntil(held, () => db.getJob(late)?.status === "done" && db.getJob(jobs[1])?.status === "done");
    await run;
  } finally {
    queue.requestStop();
    await run;
    clearHedgeSettings();
    for (const id of [...jobs, late]) if (id) db.deleteJob(id);
  }
});

test("a split job translates its title on a connection still working", async (t) => {
  hedgeSettings();
  config.setSetting("title_sidecar", "1");
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(30), "utf8");
  const titleHosts: string[] = [];
  useRawChat(
    t,
    (host, system) => {
      if (system.includes("subtitle content analyst")) return chatCompletion("Summary.");
      if (host === "a.test") throw new Error("ECONNREFUSED");
      return null;
    },
    titleHosts,
  );
  try {
    await queue.processQueue();
    assert.equal(db.getJob(job)?.status, "done");
    assert.ok(titleHosts.length > 0, "a title request was made");
    assert.deepEqual([...new Set(titleHosts)], ["b.test"]);
  } finally {
    clearHedgeSettings();
    config.setSetting("title_sidecar", "0");
    db.deleteJob(job);
  }
});
