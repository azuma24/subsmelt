import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptionWork } from "../../api.js";
import { cancellableBatchIds } from "./work-batch.js";

test("Cancel affects the displayed batch, not unrelated concurrent work", () => {
  const work = [
    { id: "current", batchId: "a", status: "running" },
    { id: "next", batchId: "a", status: "queued" },
    { id: "done", batchId: "a", status: "succeeded" },
    { id: "other", batchId: "b", status: "running" },
  ] as TranscriptionWork[];
  assert.deepEqual(cancellableBatchIds(work, "a"), ["current", "next"]);
  assert.deepEqual(cancellableBatchIds(work), []);
});
