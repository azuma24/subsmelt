import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  addJob,
  assertCuesTranslatedInOrder,
  chatCompletion,
  clearHedgeSettings,
  config,
  db,
  hedgeSettings,
  hostTag,
  queue,
  splitSrt,
  srtCueTexts,
  useParallelConnections,
  useSplitFetch,
  useStalledChunkFetch,
  waitFor,
} from "./queue-split-harness.js";

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
