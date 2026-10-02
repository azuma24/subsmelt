import test from "node:test";
import assert from "node:assert/strict";
import { jobDerived } from "./job-derived.js";
import type { JobRow } from "../../types";

function row(overrides: Partial<JobRow>): JobRow {
  return {
    id: 1,
    task_id: 1,
    srt_path: "/media/Movies/Movie.en.srt",
    output_path: "/media/Movies/Movie.chi.srt",
    video_path: null,
    status: "pending",
    priority: 0,
    force: 0,
    total_cues: 0,
    completed_cues: 0,
    error: null,
    duration_seconds: null,
    target_lang: "Chinese",
    lang_code: "chi",
    ...overrides,
  } as JobRow;
}

test("jobDerived derives the display state both surfaces share", () => {
  const pending = jobDerived(row({}));
  assert.deepEqual(
    [pending.srtName, pending.pct, pending.hasError, pending.isPending, pending.isSkipped, pending.reason],
    ["Movie.en.srt", 0, false, true, false, null],
  );

  const translating = jobDerived(row({ status: "translating", total_cues: 300, completed_cues: 150 }));
  assert.equal(translating.pct, 50);
  assert.equal(translating.isPending, false);

  // A zero total must not divide by zero into NaN.
  assert.equal(jobDerived(row({ status: "translating", total_cues: 0, completed_cues: 0 })).pct, 0);
});

test("jobDerived classifies the error reason only when there is an error", () => {
  const failed = jobDerived(row({ status: "error", error: "Request timed out after 300s" }));
  assert.equal(failed.hasError, true);
  assert.equal(failed.reason, "timeout");

  assert.equal(jobDerived(row({ status: "error", error: null })).reason, null);
  assert.equal(jobDerived(row({ status: "done", error: null })).reason, null);
});

test("jobDerived falls back to an empty name for root-level paths", () => {
  assert.equal(jobDerived(row({ srt_path: "/media/Movie.srt" })).srtName, "Movie.srt");
  assert.equal(jobDerived(row({ srt_path: "Movie.srt" })).srtName, "Movie.srt");
});
