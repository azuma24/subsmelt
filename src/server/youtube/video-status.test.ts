import test from "node:test";
import assert from "node:assert/strict";
import { VIDEO_STATUSES, canTransition, isVideoStatus } from "./video-status.js";

const ALLOWED = new Set([
  "new>queued", "new>skipped",
  "queued>downloading", "queued>skipped",
  "downloading>transcribing", "downloading>queued", "downloading>waiting", "downloading>unavailable", "downloading>failed",
  "transcribing>translating", "transcribing>transcribing", "transcribing>failed",
  "translating>done",
  "done>queued",
  "waiting>queued",
  "skipped>queued",
  "unavailable>queued",
  "failed>queued",
]);

test("canTransition allows exactly the PRD transition table", () => {
  const allowed: string[] = [];
  for (const from of VIDEO_STATUSES) {
    for (const to of VIDEO_STATUSES) {
      if (canTransition(from, to)) allowed.push(`${from}>${to}`);
    }
  }
  assert.deepEqual(new Set(allowed), ALLOWED);
});

test("refuses skipping the pipeline, such as new straight to done", () => {
  assert.equal(canTransition("new", "done"), false);
  assert.equal(canTransition("skipped", "new"), false);
  assert.equal(canTransition("translating", "queued"), false);
});

test("isVideoStatus accepts stored values and rejects anything else", () => {
  assert.equal(isVideoStatus("queued"), true);
  assert.equal(isVideoStatus("removed"), false);
  assert.equal(isVideoStatus(""), false);
});
