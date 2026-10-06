import test from "node:test";
import assert from "node:assert/strict";
import { recentDurationsSeconds } from "./eta.js";
import type { Job } from "../../types.js";
import { makeJob } from "../../test-fixtures.js";

const done = (id: number, duration_seconds: number | null, started_at: string | null = null): Job =>
  makeJob({ id, status: "done", total_cues: 1, completed_cues: 1, duration_seconds, started_at });

test("takes the most recent finished jobs from a newest-first list, not the oldest", () => {
  const jobs = Array.from({ length: 25 }, (_, i) => done(100 - i, i + 1));
  assert.deepEqual(
    recentDurationsSeconds(jobs, 20),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
});

test("orders by start time when it is recorded, skipping jobs without a duration", () => {
  const jobs = [
    done(1, 30, "2026-09-30 10:00:00"),
    done(2, null, "2026-09-30 12:00:00"),
    done(3, 50, "2026-09-30 11:00:00"),
    done(4, 0, "2026-09-30 13:00:00"),
  ];
  assert.deepEqual(recentDurationsSeconds(jobs, 20), [50, 30]);
  assert.deepEqual(recentDurationsSeconds(jobs, 1), [50]);
});
