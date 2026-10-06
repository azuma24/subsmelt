import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  getSSEInvalidationKeys,
  parseSSEData,
  createDebouncedInvalidator,
  createSseInvalidator,
  withJobEvent,
  withVideoProgress,
  type JobsResponse,
} from "./hooks.js";
import type { Job, YoutubeVideo } from "./types.js";

test("parseSSEData returns parsed object payloads and ignores invalid JSON", () => {
  assert.deepEqual(parseSSEData('{"jobId":123,"status":"done"}'), { jobId: 123, status: "done" });
  assert.deepEqual(parseSSEData("[]"), {});
  assert.deepEqual(parseSSEData("not-json"), {});
});

test("SSE invalidation keys are targeted by event type", () => {
  // Progress, connection and analysis events patch the cached jobs list instead of refetching it.
  assert.deepEqual(getSSEInvalidationKeys("job:progress"), [["queue-status"]]);
  assert.deepEqual(getSSEInvalidationKeys("job:analysis"), []);
  assert.deepEqual(getSSEInvalidationKeys("job:start"), [["jobs"], ["queue-status"], ["llm-status"]]);
  assert.deepEqual(getSSEInvalidationKeys("job:done"), [["jobs"], ["queue-status"], ["logs"], ["transcription-history"], ["llm-status"]]);
  assert.deepEqual(getSSEInvalidationKeys("job:connection"), [["queue-status"], ["llm-status"]]);
  assert.deepEqual(getSSEInvalidationKeys("queue:finished"), [["jobs"], ["queue-status"], ["logs"], ["transcription-history"], ["library"], ["llm-status"]]);
  assert.deepEqual(getSSEInvalidationKeys("scan:complete"), [["jobs"], ["queue-status"], ["logs"], ["settings"], ["transcription-history"], ["library"]]);
  assert.deepEqual(getSSEInvalidationKeys("youtube:playlist"), [["youtube"]]);
  assert.deepEqual(getSSEInvalidationKeys("youtube:video"), [["youtube", "playlists"], ["youtube", "videos"], ["youtube", "pipeline"]]);
  assert.deepEqual(getSSEInvalidationKeys("youtube:cooldown"), [["youtube", "status"], ["youtube", "pipeline"]]);
});

test("a youtube:video progress tick patches only the matching cached row", () => {
  const row = (video_id: string, status: YoutubeVideo["status"]) => ({ video_id, status }) as YoutubeVideo;
  const patched = withVideoProgress({ videos: [row("qD0_yWgifDM", "queued"), row("uXspbC2srEQ", "queued")] }, "qD0_yWgifDM", "downloading", 42);
  assert.deepEqual(patched?.videos.map((v) => [v.video_id, v.status, v.pct]), [
    ["qD0_yWgifDM", "downloading", 42],
    ["uXspbC2srEQ", "queued", undefined],
  ]);
  const whisper = withVideoProgress({ videos: [row("qD0_yWgifDM", "transcribing")] }, "qD0_yWgifDM", "transcribing", 30);
  assert.deepEqual(whisper?.videos.map((v) => [v.status, v.pct]), [["transcribing", 30]]);
  assert.equal(withVideoProgress(undefined, "qD0_yWgifDM", "downloading", 42), undefined);
});

test("createDebouncedInvalidator batches duplicate keys until flushed", () => {
  const invalidated: ReadonlyArray<unknown>[] = [];
  const invalidator = createDebouncedInvalidator((queryKey) => invalidated.push(queryKey), 250);

  invalidator.schedule([["jobs"], ["queue-status"]]);
  invalidator.schedule([["jobs"], ["logs"]]);

  assert.deepEqual(invalidated, []);
  invalidator.flush();
  assert.deepEqual(invalidated, [["jobs"], ["queue-status"], ["logs"]]);
});

const job = (id: number, status: string): Job => ({ id, status, completed_cues: 0, total_cues: 0, error: null, connection: null }) as Job;
const jobs = (...rows: Job[]): JobsResponse => ({ jobs: rows, queueRunning: true, currentJobId: null });

test("job events patch only their job in the cached list", () => {
  const list = jobs(job(1, "translating"), job(2, "pending"));
  const progressed = withJobEvent(list, "job:progress", { jobId: 1, completed: 40, total: 120, pct: 33 });
  assert.deepEqual(progressed?.jobs.map((j) => [j.id, j.completed_cues, j.total_cues]), [[1, 40, 120], [2, 0, 0]]);

  const connection = { id: "gpu", label: "Desk", host: "http://gpu/v1", model: "qwen" };
  assert.deepEqual(withJobEvent(list, "job:connection", { jobId: 1, ...connection })?.jobs[0].connection, connection);
  assert.equal(withJobEvent(list, "job:analysis", { jobId: 1, analysis: "Names: Ana" })?.jobs[0].analysis_context, "Names: Ana");
  assert.equal(withJobEvent(list, "job:start", { jobId: 2 })?.jobs[1].status, "translating");
  assert.equal(withJobEvent(list, "job:done", { jobId: 1, durationSeconds: 12 })?.jobs[0].status, "done");
  const failed = withJobEvent(list, "job:error", { jobId: 1, error: "timeout" })?.jobs[0];
  assert.deepEqual([failed?.status, failed?.error], ["error", "timeout"]);
  assert.equal(withJobEvent(list, "job:stopped", { jobId: 1 })?.jobs[0].status, "pending");

  // An event without a job id, or for a job the list does not have, changes nothing.
  assert.equal(withJobEvent(list, "job:progress", {}), list);
  assert.equal(withJobEvent(list, "job:done", { jobId: 99 }), list);
  assert.equal(withJobEvent(undefined, "job:done", { jobId: 1 }), undefined);
});

test("the jobs list refetches at most once per jobs window; other queries keep the short delay", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const invalidated: unknown[] = [];
    const invalidator = createSseInvalidator((key) => invalidated.push(key), { delayMs: 300, jobsDelayMs: 2000 });
    invalidator.schedule([["jobs"], ["queue-status"]]);
    mock.timers.tick(300);
    assert.deepEqual(invalidated, [["queue-status"]]);
    // A burst of status events inside the window joins the one refetch.
    invalidator.schedule([["jobs"], ["logs"]]);
    invalidator.schedule([["jobs"]]);
    mock.timers.tick(1700);
    assert.deepEqual(invalidated, [["queue-status"], ["logs"], ["jobs"]]);
    invalidator.schedule([["jobs"]]);
    invalidator.cancel();
    mock.timers.tick(5000);
    assert.equal(invalidated.length, 3);
  } finally {
    mock.timers.reset();
  }
});
