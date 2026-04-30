import test from "node:test";
import assert from "node:assert/strict";
import {
  createManualTranscriptionProgress,
  transitionManualTranscriptionProgress,
} from "./transcription-progress.js";

test("manual transcription progresses through coarse client-side stages", () => {
  const initial = createManualTranscriptionProgress("transcribe_and_translate");
  assert.equal(initial.stage, "preflighting");

  const transcribing = transitionManualTranscriptionProgress(initial, { type: "preflight-passed" });
  assert.equal(transcribing.stage, "transcribing");

  const queueing = transitionManualTranscriptionProgress(transcribing, { type: "backend-finished" });
  assert.equal(queueing.stage, "queueing");

  const complete = transitionManualTranscriptionProgress(queueing, { type: "scan-queued" });
  assert.equal(complete.stage, "complete");
});

test("transcribe-only requests finish without a queueing stage", () => {
  const initial = createManualTranscriptionProgress("transcribe_only");
  const transcribing = transitionManualTranscriptionProgress(initial, { type: "preflight-passed" });
  const complete = transitionManualTranscriptionProgress(transcribing, { type: "backend-finished" });

  assert.equal(complete.stage, "complete");
});

test("skip-style errors are classified separately from failures", () => {
  const initial = createManualTranscriptionProgress("transcribe_only");
  const skipped = transitionManualTranscriptionProgress(initial, {
    type: "error",
    message: "Transcription skipped: insufficient RAM",
  });
  const failed = transitionManualTranscriptionProgress(initial, {
    type: "error",
    message: "Transcription backend returned HTTP 500",
  });

  assert.equal(skipped.stage, "skipped");
  assert.equal(failed.stage, "failed");
});
