import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// db.ts opens its database at import, so point DATA_DIR at a scratch folder first.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-db-"));
const db = await import("./db.js");

function seed(status: string, extra: Partial<{ completed_cues: number }> = {}) {
  const result = db.createJob({
    task_id: 1,
    srt_path: `/media/${status}-${Math.random()}.srt`,
    output_path: `/media/${status}.eng.srt`,
    video_path: null,
    status,
  });
  const id = Number(result.lastInsertRowid);
  if (extra.completed_cues !== undefined) db.updateJob(id, extra);
  return id;
}

test("single-job reset, force and delete refuse a job a worker is translating", () => {
  const running = seed("translating", { completed_cues: 42 });

  const reset = db.resetJob(running);
  assert.equal(db.getJob(running)?.status, "translating");
  assert.equal(db.getJob(running)?.completed_cues, 42);
  assert.equal(reset, 0);

  const forced = db.forceJob(running);
  assert.equal(db.getJob(running)?.status, "translating");
  assert.equal(db.getJob(running)?.force, 0);
  assert.equal(forced, 0);

  const deleted = db.deleteJob(running);
  assert.equal(db.getJob(running)?.status, "translating");
  assert.equal(deleted, 0);
});

test("startup returns interrupted jobs to pending with their progress cleared", () => {
  // Nothing resumes from the partial, so a stale count would show a pending
  // job as part-done until it is claimed again.
  const interrupted = seed("translating", { completed_cues: 42 });

  db.resetInterruptedJobs();

  assert.deepEqual(
    [db.getJob(interrupted)?.status, db.getJob(interrupted)?.completed_cues],
    ["pending", 0],
  );
  assert.deepEqual(db.getJobs("translating").map((job) => job.id), []);
});

test("single-job reset, force and delete still act on jobs no worker holds", () => {
  const errored = seed("error", { completed_cues: 7 });
  assert.equal(db.resetJob(errored), 1);
  assert.deepEqual(
    [db.getJob(errored)?.status, db.getJob(errored)?.completed_cues],
    ["pending", 0],
  );

  const done = seed("done");
  assert.equal(db.forceJob(done), 1);
  assert.deepEqual([db.getJob(done)?.status, db.getJob(done)?.force], ["pending", 1]);

  const pending = seed("pending");
  assert.equal(db.deleteJob(pending), 1);
  assert.equal(db.getJob(pending), undefined);
});
