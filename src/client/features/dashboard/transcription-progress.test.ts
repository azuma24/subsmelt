import test from "node:test";
import assert from "node:assert/strict";
import {
  createManualTranscriptionProgress,
  isManualTranscriptionBusy,
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

test("real per-segment progress is recorded only while transcribing", () => {
  const initial = createManualTranscriptionProgress("transcribe_only");
  const transcribing = transitionManualTranscriptionProgress(initial, { type: "preflight-passed" });

  const at40 = transitionManualTranscriptionProgress(transcribing, { type: "progress", pct: 40 });
  assert.equal(at40.pct, 40);
  assert.equal(at40.stage, "transcribing");

  // Out-of-range values are clamped.
  const clamped = transitionManualTranscriptionProgress(at40, { type: "progress", pct: 250 });
  assert.equal(clamped.pct, 100);

  // Progress events arriving before transcribing (e.g. during preflight) are ignored.
  const ignored = transitionManualTranscriptionProgress(initial, { type: "progress", pct: 55 });
  assert.equal(ignored.pct, undefined);
  assert.equal(ignored.stage, "preflighting");
});

test("cancel-requested moves to cancelling, then cancelled is terminal", () => {
  const initial = createManualTranscriptionProgress("transcribe_only");
  const transcribing = transitionManualTranscriptionProgress(initial, { type: "preflight-passed" });

  const cancelling = transitionManualTranscriptionProgress(transcribing, { type: "cancel-requested" });
  assert.equal(cancelling.stage, "cancelling");
  assert.equal(isManualTranscriptionBusy(cancelling), true);

  const cancelled = transitionManualTranscriptionProgress(cancelling, { type: "cancelled" });
  assert.equal(cancelled.stage, "cancelled");
  assert.equal(isManualTranscriptionBusy(cancelled), false);

  // A cancellation error message also classifies as cancelled (not failed).
  const viaError = transitionManualTranscriptionProgress(transcribing, {
    type: "error",
    message: "Transcription cancelled",
  });
  assert.equal(viaError.stage, "cancelled");
});

test("cancel-requested is ignored once a terminal state is reached", () => {
  const initial = createManualTranscriptionProgress("transcribe_only");
  const transcribing = transitionManualTranscriptionProgress(initial, { type: "preflight-passed" });
  const complete = transitionManualTranscriptionProgress(transcribing, { type: "backend-finished" });

  const stillComplete = transitionManualTranscriptionProgress(complete, { type: "cancel-requested" });
  assert.equal(stillComplete.stage, "complete");
});
