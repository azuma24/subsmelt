import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  addJob,
  chatCompletion,
  config,
  db,
  queue,
  splitSrt,
  useConnections,
  useSplitFetch,
  waitFor,
} from "./queue-split-harness.js";

type Fetch = Parameters<typeof useSplitFetch>;

function useSingleConnection() {
  useConnections("single", [
    { id: "a", label: "A", provider: "local", model: "m", endpoint: "http://a.test/v1", order: 0 },
  ]);
  config.setSetting("disable_tool_calls", "1");
}

function useCountingFetch(t: Fetch[0], chunk?: () => Promise<void>) {
  const calls = { analysis: 0, chunk: 0 };
  useSplitFetch(t, async (info, init) => {
    if (info.kind === "analysis") {
      calls.analysis += 1;
      return chatCompletion(`Summary ${calls.analysis}.`);
    }
    calls.chunk += 1;
    await Promise.race([
      chunk?.(),
      new Promise((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }),
    ]);
    return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
  });
  return calls;
}

function newJob() {
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(3), "utf8");
  return job;
}

/** Runs the job once to a finished state, then queues it again the way Retry does. */
async function finishThenRequeue(job: number) {
  await queue.processQueue();
  assert.equal(db.getJob(job)?.status, "done");
  fs.rmSync(db.getJob(job)!.output_path);
  db.resetJob(job);
}

test("a job stopped after its analysis does not analyze again", async (t) => {
  useSingleConnection();
  const job = newJob();
  let hold: Promise<void> = new Promise(() => {});
  const calls = useCountingFetch(t, () => hold);
  const run = queue.processQueue();
  try {
    await waitFor(() => calls.chunk > 0, "the first chunk");
    assert.equal(db.getJob(job)?.analysis_context, "Summary 1.");
    queue.requestStop();
    await run;
    assert.equal(db.getJob(job)?.status, "pending");
    hold = Promise.resolve();
    await queue.processQueue();
    assert.equal(db.getJob(job)?.status, "done");
    assert.equal(calls.analysis, 1);
    assert.equal(db.getJob(job)?.analysis_context, "Summary 1.");
  } finally {
    db.deleteJob(job);
  }
});

test("a retried job reuses its analysis", async (t) => {
  useSingleConnection();
  const job = newJob();
  const calls = useCountingFetch(t);
  try {
    await finishThenRequeue(job);
    await queue.processQueue();
    assert.equal(calls.analysis, 1);
  } finally {
    db.deleteJob(job);
  }
});

test("a changed source file is analyzed again", async (t) => {
  useSingleConnection();
  const job = newJob();
  const calls = useCountingFetch(t);
  try {
    await finishThenRequeue(job);
    fs.appendFileSync(db.getJob(job)!.srt_path, "\n4\n00:00:02,000 --> 00:00:03,000\nnew line\n");
    await queue.processQueue();
    assert.equal(calls.analysis, 2);
    assert.equal(db.getJob(job)?.analysis_context, "Summary 2.");
  } finally {
    db.deleteJob(job);
  }
});

test("a changed prompt is analyzed again", async (t) => {
  useSingleConnection();
  const job = newJob();
  const calls = useCountingFetch(t);
  try {
    await finishThenRequeue(job);
    config.setSetting("prompt", "A different prompt for {{lang}}.");
    await queue.processQueue();
    assert.equal(calls.analysis, 2);
  } finally {
    config.setSetting("prompt", "");
    db.deleteJob(job);
  }
});

test("a forced re-translate is analyzed again", async (t) => {
  useSingleConnection();
  const job = newJob();
  const calls = useCountingFetch(t);
  try {
    await queue.processQueue();
    assert.equal(db.forceJob(job), 1);
    await queue.processQueue();
    assert.equal(calls.analysis, 2);
  } finally {
    db.deleteJob(job);
  }
});

test("no analysis is reused from a run that produced none", async (t) => {
  useSingleConnection();
  const job = newJob();
  let analyses = 0;
  useSplitFetch(t, (info) => {
    if (info.kind === "analysis") {
      analyses += 1;
      return new Response('{"error":"bad"}', { status: 400 });
    }
    return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
  });
  try {
    await finishThenRequeue(job);
    await queue.processQueue();
    assert.equal(analyses, 2);
  } finally {
    db.deleteJob(job);
  }
});

test("changed Additional Context is analyzed again", async (t) => {
  useSingleConnection();
  const job = newJob();
  const calls = useCountingFetch(t);
  try {
    await finishThenRequeue(job);
    config.setSetting("additional_context", "Use a formal register.");
    await queue.processQueue();
    assert.equal(calls.analysis, 2);
  } finally {
    config.setSetting("additional_context", "");
    db.deleteJob(job);
  }
});

test("a changed source language is analyzed again", async (t) => {
  useSingleConnection();
  const job = newJob();
  const calls = useCountingFetch(t);
  const taskId = db.getJob(job)!.task_id;
  try {
    await finishThenRequeue(job);
    config.updateTask(taskId, { source_lang: "Japanese" });
    await queue.processQueue();
    assert.equal(calls.analysis, 2);
  } finally {
    config.updateTask(taskId, { source_lang: "Automatic" });
    db.deleteJob(job);
  }
});

test("a stale analysis is not kept when the new pass produces none", async (t) => {
  useSingleConnection();
  const job = newJob();
  let fail = false;
  useSplitFetch(t, (info) => {
    if (info.kind === "analysis") {
      return fail ? new Response('{"error":"bad"}', { status: 400 }) : chatCompletion("Old summary.");
    }
    return chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)));
  });
  try {
    await finishThenRequeue(job);
    fail = true;
    fs.appendFileSync(db.getJob(job)!.srt_path, "\n4\n00:00:02,000 --> 00:00:03,000\nnew line\n");
    await queue.processQueue();
    assert.equal(db.getJob(job)?.analysis_context, null);
  } finally {
    db.deleteJob(job);
  }
});

test("a forced job stopped after its analysis keeps that analysis", async (t) => {
  useSingleConnection();
  const job = newJob();
  let hold: Promise<void> = Promise.resolve();
  const calls = useCountingFetch(t, () => hold);
  try {
    await queue.processQueue();
    assert.equal(db.forceJob(job), 1);
    hold = new Promise(() => {});
    const run = queue.processQueue();
    await waitFor(() => calls.analysis === 2 && calls.chunk > 1, "the forced run's first chunk");
    queue.requestStop();
    await run;
    hold = Promise.resolve();
    await queue.processQueue();
    assert.equal(calls.analysis, 2);
    assert.equal(db.getJob(job)?.status, "done");
  } finally {
    db.deleteJob(job);
  }
});

test("a changed Analysis Sample is analyzed again", async (t) => {
  useSingleConnection();
  const job = newJob();
  const calls = useCountingFetch(t);
  try {
    await finishThenRequeue(job);
    config.setSetting("analysis_max_lines", "1000");
    await queue.processQueue();
    assert.equal(calls.analysis, 2);
  } finally {
    config.setSetting("analysis_max_lines", "");
    db.deleteJob(job);
  }
});
