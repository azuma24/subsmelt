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
  srtCueTexts,
  useConnections,
  useSplitFetch,
  waitFor,
} from "./queue-split-harness.js";
import { cueProgressPath } from "./translator/cue-progress.js";

function useResumableJob(t: Parameters<typeof useSplitFetch>[0]) {
  useConnections("single", [
    { id: "a", label: "A", provider: "local", model: "m", endpoint: "http://a.test/v1", order: 0 },
  ]);
  config.setSetting("disable_tool_calls", "1");
  config.setSetting("chunk_size", "1");
  const state = { tag: "OLD", stallOn: "cue 3" as string | null, sent: [] as string[] };
  useSplitFetch(t, (info, init) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    state.sent.push(...info.lines);
    if (state.stallOn && info.lines.includes(state.stallOn)) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    }
    return chatCompletion(JSON.stringify(info.lines.map((l) => `${state.tag}-${l}`)));
  });
  const job = addJob({ srtExists: true, outputExists: false });
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(4), "utf8");
  t.after(() => {
    config.setSetting("chunk_size", "");
    db.deleteJob(job);
  });
  return { job, state };
}

async function stopAtTheStall(job: number, state: { sent: string[]; stallOn: string | null; tag: string }) {
  const run = queue.processQueue();
  await waitFor(() => state.sent.includes("cue 3"), "the stalled chunk");
  queue.requestStop();
  await run;
  assert.equal(db.getJob(job)?.status, "pending");
  state.sent.length = 0;
  state.stallOn = null;
  state.tag = "NEW";
}

const texts = (job: number) => srtCueTexts(fs.readFileSync(db.getJob(job)!.output_path, "utf8"));

test("Stop then Start continues the file where it stopped", async (t) => {
  const { job, state } = useResumableJob(t);
  await stopAtTheStall(job, state);
  await queue.processQueue();
  assert.deepEqual(state.sent, ["cue 3", "cue 4"]);
  assert.deepEqual(texts(job), ["OLD-cue 1", "OLD-cue 2", "NEW-cue 3", "NEW-cue 4"]);
  assert.deepEqual([db.getJob(job)?.status, db.getJob(job)?.completed_cues], ["done", 4]);
  assert.equal(fs.existsSync(cueProgressPath(db.getJob(job)!.output_path)), false);
});

test("a forced re-translate starts over", async (t) => {
  const { job, state } = useResumableJob(t);
  await stopAtTheStall(job, state);
  assert.equal(queue.forceJobFromScratch(job), 1);
  await queue.processQueue();
  assert.deepEqual(state.sent, ["cue 1", "cue 2", "cue 3", "cue 4"]);
  assert.deepEqual(texts(job), ["NEW-cue 1", "NEW-cue 2", "NEW-cue 3", "NEW-cue 4"]);
});

test("a changed source file starts over", async (t) => {
  const { job, state } = useResumableJob(t);
  await stopAtTheStall(job, state);
  fs.writeFileSync(db.getJob(job)!.srt_path, splitSrt(4).replace("cue 1", "changed"), "utf8");
  await queue.processQueue();
  assert.deepEqual(texts(job), ["NEW-changed", "NEW-cue 2", "NEW-cue 3", "NEW-cue 4"]);
});

test("a changed target language starts over", async (t) => {
  const { job, state } = useResumableJob(t);
  await stopAtTheStall(job, state);
  const taskId = db.getJob(job)!.task_id;
  config.updateTask(taskId, { target_lang: "Japanese" });
  t.after(() => config.updateTask(taskId, { target_lang: "Chinese" }));
  await queue.processQueue();
  assert.deepEqual(state.sent, ["cue 1", "cue 2", "cue 3", "cue 4"]);
});

test("changed Additional Context starts over", async (t) => {
  const { job, state } = useResumableJob(t);
  await stopAtTheStall(job, state);
  config.setSetting("additional_context", "Use a formal register.");
  t.after(() => config.setSetting("additional_context", ""));
  await queue.processQueue();
  assert.deepEqual(state.sent, ["cue 1", "cue 2", "cue 3", "cue 4"]);
});

test("a forced job stopped partway continues on its next start", async (t) => {
  const { job, state } = useResumableJob(t);
  await stopAtTheStall(job, state);
  await queue.processQueue();
  assert.equal(queue.forceJobFromScratch(job), 1);
  state.sent.length = 0;
  state.stallOn = "cue 3";
  await stopAtTheStall(job, state);
  await queue.processQueue();
  assert.deepEqual(state.sent, ["cue 3", "cue 4"]);
  assert.equal(db.getJob(job)?.status, "done");
});

test("a resumed job shows its kept cues at once and keeps the earlier run's totals", async (t) => {
  const { job, state } = useResumableJob(t);
  await stopAtTheStall(job, state);
  const before = db.getJob(job)!;
  assert.ok((before.input_tokens ?? 0) > 0);
  state.stallOn = "cue 3";
  state.sent.length = 0;
  const run = queue.processQueue();
  await waitFor(() => state.sent.includes("cue 3"), "the resumed run's first chunk");
  assert.equal(db.getJob(job)?.completed_cues, 2);
  assert.ok((db.getJob(job)?.input_tokens ?? 0) >= (before.input_tokens ?? 0));
  queue.requestStop();
  await run;
});

test("a job skipped because its output appeared leaves no progress behind", async (t) => {
  const { job, state } = useResumableJob(t);
  await stopAtTheStall(job, state);
  const output = db.getJob(job)!.output_path;
  fs.writeFileSync(output, "1\n00:00:01,000 --> 00:00:02,000\nmade elsewhere\n", "utf8");
  await queue.processQueue();
  assert.equal(db.getJob(job)?.status, "skipped");
  assert.equal(fs.existsSync(cueProgressPath(output)), false);
});

test("a changed Analysis Sample keeps the finished chunks", async (t) => {
  const { job, state } = useResumableJob(t);
  await stopAtTheStall(job, state);
  config.setSetting("analysis_max_lines", "1000");
  t.after(() => config.setSetting("analysis_max_lines", ""));
  await queue.processQueue();
  assert.deepEqual(state.sent, ["cue 3", "cue 4"]);
});
