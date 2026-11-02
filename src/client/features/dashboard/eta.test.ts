import test from "node:test";
import assert from "node:assert/strict";
import {
  elapsedSince,
  estimateJobEta,
  estimateQueueEta,
  formatEta,
  MIN_COMPLETED_CUES,
  MIN_ELAPSED_MS,
} from "./eta.js";

test("projects remaining time from observed throughput", () => {
  // 100 cues in 60s → 100 cues/min; 300 left → 3 minutes.
  const eta = estimateJobEta({ completed: 100, total: 400, elapsedMs: 60_000 });
  assert.ok(eta);
  assert.equal(Math.round(eta!.cuesPerMinute), 100);
  assert.equal(Math.round(eta!.remainingMs / 1000), 180);
});

test("withholds an estimate until there is enough signal", () => {
  // Too early: a couple of cues in a couple of seconds extrapolates to nonsense.
  assert.equal(estimateJobEta({ completed: 2, total: 400, elapsedMs: 2_000 }), null);
  assert.equal(estimateJobEta({ completed: MIN_COMPLETED_CUES, total: 400, elapsedMs: MIN_ELAPSED_MS - 1 }), null);
  assert.equal(estimateJobEta({ completed: MIN_COMPLETED_CUES - 1, total: 400, elapsedMs: MIN_ELAPSED_MS }), null);
  // Context analysis phase: total is still unknown.
  assert.equal(estimateJobEta({ completed: 0, total: 0, elapsedMs: 60_000 }), null);
  // Already finished.
  assert.equal(estimateJobEta({ completed: 400, total: 400, elapsedMs: 60_000 }), null);
});

test("queue estimate uses the median so one stalled job does not dominate", () => {
  // Durations 60s, 60s, 70s and one 2-hour outlier: mean would be ~30m/job.
  const eta = estimateQueueEta(2, [60, 60, 70, 7200]);
  assert.ok(eta);
  assert.equal(eta! / 1000, 130); // median 65s × 2 pending
});

test("queue estimate needs both pending work and history", () => {
  assert.equal(estimateQueueEta(0, [60]), null);
  assert.equal(estimateQueueEta(3, []), null);
  assert.equal(estimateQueueEta(3, [0, -5]), null);
});

test("formats durations coarsely", () => {
  assert.equal(formatEta(45_000), "45s");
  assert.equal(formatEta(12 * 60_000), "12m");
  assert.equal(formatEta(125 * 60_000), "2h 05m");
  assert.equal(formatEta(0), "0s");
  assert.equal(formatEta(Number.NaN), "0s");
});

test("elapsed treats SQLite timestamps as UTC", () => {
  // datetime('now') has no zone marker; parsing it as local time would skew
  // every estimate by the machine's offset.
  const startedAt = "2026-07-31 10:00:00";
  const now = Date.parse("2026-07-31T10:05:00Z");
  assert.equal(elapsedSince(startedAt, now), 5 * 60_000);
});

test("elapsed is null for missing, unparseable or future timestamps", () => {
  assert.equal(elapsedSince(null), null);
  assert.equal(elapsedSince(undefined), null);
  assert.equal(elapsedSince("not a date"), null);
  assert.equal(elapsedSince("2026-07-31 10:00:00", Date.parse("2026-07-31T09:00:00Z")), null);
});
