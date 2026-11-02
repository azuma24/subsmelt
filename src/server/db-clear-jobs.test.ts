import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// db.ts opens its database at import, so point DATA_DIR at a scratch folder first.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-db-"));
const db = await import("./db.js");

test("clearing the queue removes finished jobs and keeps pending and running ones", () => {
  const statuses = ["pending", "translating", "done", "skipped", "error"];
  for (const status of statuses) {
    db.createJob({
      task_id: 1,
      srt_path: `/media/${status}.srt`,
      output_path: `/media/${status}.eng.srt`,
      video_path: null,
      status,
    });
  }

  const removed = db.clearFinishedJobs();

  assert.equal(removed, 3);
  assert.deepEqual(
    db
      .getJobs()
      .map((job) => job.status)
      .sort(),
    ["pending", "translating"],
  );
});
