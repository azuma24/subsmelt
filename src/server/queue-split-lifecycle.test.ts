import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  addJob,
  answerAllUntil,
  assertCuesTranslatedInOrder,
  chatCompletion,
  clearHedgeSettings,
  config,
  db,
  hedgeSettings,
  queue,
  splitSrt,
  useConnections,
  useHoldingFetch,
  useParallelConnections,
  useRawChat,
  useSplitFetch,
  useStalledChunkFetch,
  waitFor,
} from "./queue-split-harness.js";

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
