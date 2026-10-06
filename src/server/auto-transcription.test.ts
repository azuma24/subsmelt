import { test } from "node:test";
import assert from "node:assert/strict";
import { claimAutoTranscriptions, releaseAutoTranscription } from "./auto-transcription.js";

test("an overlapping scan skips videos another scan is already transcribing", () => {
  assert.deepEqual(claimAutoTranscriptions(["/media/a.mkv", "/media/b.mkv"]), ["/media/a.mkv", "/media/b.mkv"]);
  assert.deepEqual(claimAutoTranscriptions(["/media/b.mkv", "/media/c.mkv"]), ["/media/c.mkv"]);
});

test("a video released after its run can be claimed by the next scan", () => {
  assert.deepEqual(claimAutoTranscriptions(["/media/d.mkv"]), ["/media/d.mkv"]);
  assert.deepEqual(claimAutoTranscriptions(["/media/d.mkv"]), []);
  releaseAutoTranscription("/media/d.mkv");
  assert.deepEqual(claimAutoTranscriptions(["/media/d.mkv"]), ["/media/d.mkv"]);
});
