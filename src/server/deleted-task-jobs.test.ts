import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.ts and db.ts load from these folders at import, so set them first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-deleted-task-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = path.join(root, "media");
fs.mkdirSync(process.env.CONFIG_DIR);
fs.writeFileSync(
  path.join(process.env.CONFIG_DIR, "config.json"),
  JSON.stringify({ settings: { llm_endpoint: "http://127.0.0.1:9/v1" } }),
);
const db = await import("./db.js");
const { processQueue } = await import("./queue.js");

test("deleting a task's pending jobs keeps its finished jobs and other tasks' jobs", () => {
  const jobs = [[2, "pending"], [2, "done"], [2, "error"], [3, "pending"]] as const;
  for (const [taskId, status] of jobs) {
    db.createJob({
      task_id: taskId,
      srt_path: `/media/${taskId}-${status}.srt`,
      output_path: `/media/${taskId}-${status}.out.srt`,
      video_path: null,
      status,
    });
  }

  const removed = db.deletePendingJobsForTask(2);

  assert.equal(removed, 1);
  assert.deepEqual(
    db.getJobs().map((job) => `${job.task_id}:${job.status}`).sort(),
    ["2:done", "2:error", "3:pending"],
  );
});

test("the worker fails a job whose task no longer exists instead of translating it", async () => {
  const outputPath = path.join(root, "orphan.fra.srt");
  const { lastInsertRowid } = db.createJob({
    task_id: 99,
    srt_path: path.join(root, "orphan.srt"),
    output_path: outputPath,
    video_path: null,
  });
  const jobId = Number(lastInsertRowid);

  await processQueue([jobId]);

  const job = db.getJob(jobId);
  assert.equal(job?.status, "error");
  assert.equal(job?.error, "Translation task #99 no longer exists");
  assert.equal(fs.existsSync(outputPath), false);
});
