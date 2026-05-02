import test from "node:test";
import assert from "node:assert/strict";
import {
  getSSEInvalidationKeys,
  parseSSEData,
  createDebouncedInvalidator,
} from "./hooks.js";

test("parseSSEData returns parsed object payloads and ignores invalid JSON", () => {
  assert.deepEqual(parseSSEData('{"jobId":123,"status":"done"}'), { jobId: 123, status: "done" });
  assert.deepEqual(parseSSEData("[]"), {});
  assert.deepEqual(parseSSEData("not-json"), {});
});

test("SSE invalidation keys are targeted by event type", () => {
  assert.deepEqual(getSSEInvalidationKeys("job:progress"), [["jobs"], ["queue-status"]]);
  assert.deepEqual(getSSEInvalidationKeys("job:done"), [["jobs"], ["queue-status"], ["logs"], ["transcription-history"]]);
  assert.deepEqual(getSSEInvalidationKeys("scan:complete"), [["jobs"], ["queue-status"], ["logs"], ["settings"], ["transcription-history"]]);
});

test("createDebouncedInvalidator batches duplicate keys until flushed", () => {
  const invalidated: unknown[][] = [];
  const invalidator = createDebouncedInvalidator((queryKey) => invalidated.push(queryKey), 250);

  invalidator.schedule([["jobs"], ["queue-status"]]);
  invalidator.schedule([["jobs"], ["logs"]]);

  assert.deepEqual(invalidated, []);
  invalidator.flush();
  assert.deepEqual(invalidated, [["jobs"], ["queue-status"], ["logs"]]);
});
