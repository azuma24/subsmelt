import test from "node:test";
import assert from "node:assert/strict";
import { VIDEO_STATUSES, canTransition } from "./video-status.js";

const ALLOWED = new Set([
  "new>queued", "new>skipped",
  "queued>downloading", "queued>skipped",
  "downloading>transcribing", "downloading>queued", "downloading>waiting", "downloading>unavailable", "downloading>failed", "downloading>skipped",
  "transcribing>translating", "transcribing>transcribing", "transcribing>failed",
  "translating>done",
  "done>queued",
  "waiting>queued", "waiting>skipped",
  "skipped>queued", "skipped>new",
  "unavailable>queued",
  "failed>queued", "failed>skipped",
]);

test("canTransition allows exactly the PRD transition table plus the download-step moves", () => {
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
  assert.equal(canTransition("unavailable", "new"), false);
  assert.equal(canTransition("translating", "queued"), false);
});
