import test from "node:test";
import assert from "node:assert/strict";
import {
  SINGLE_LINE_FAILURE_LIMIT,
  SINGLE_LINE_TIMEOUT_CAP_MS,
  runLineFallback,
  singleLineTimeoutMs,
} from "./fallback-policy.js";

test("per-line calls never inherit the full job timeout", () => {
  // The reported hang used a 300s job timeout; a per-line call inheriting that
  // is what turned one chunk into hours of sequential stalls.
  assert.equal(singleLineTimeoutMs(300_000), SINGLE_LINE_TIMEOUT_CAP_MS);
  // A job timeout below the cap is respected as-is.
  assert.equal(singleLineTimeoutMs(15_000), 15_000);
  // Unset still gets the cap rather than running unbounded.
  assert.equal(singleLineTimeoutMs(undefined), SINGLE_LINE_TIMEOUT_CAP_MS);
});

test("all lines translate when the backend is healthy", async () => {
  const result = await runLineFallback(["a", "b", "c"], {
    translateLine: async (line) => line.toUpperCase(),
  });

  assert.deepEqual(result.translations, ["A", "B", "C"]);
  assert.equal(result.failures, 0);
});

test("a dead backend aborts the run instead of walking every line", async () => {
  let calls = 0;
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);

  await assert.rejects(
    () => runLineFallback(lines, {
      translateLine: async () => { calls += 1; throw new Error("Request timed out after 300s"); },
    }),
    /aborted after 3 consecutive failures/,
  );

  // The whole point: 3 attempts, not 20.
  assert.equal(calls, SINGLE_LINE_FAILURE_LIMIT);
});

test("isolated failures do not abort the run", async () => {
  // A chunk that fails only because one line breaks the model is exactly the
  // case the fallback exists for.
  const result = await runLineFallback(["a", "bad", "c", "bad", "e"], {
    translateLine: async (line) => {
      if (line === "bad") throw new Error("did not match schema");
      return line.toUpperCase();
    },
  });

  assert.deepEqual(result.translations, ["A", null, "C", null, "E"]);
  assert.equal(result.failures, 2);
});

test("the failure streak resets on success", async () => {
  // Two failures, a success, then two more must NOT trip a limit of three.
  const script = ["fail", "fail", "ok", "fail", "fail"];
  const result = await runLineFallback(script, {
    translateLine: async (line) => {
      if (line === "fail") throw new Error("timeout");
      return "done";
    },
  });

  assert.equal(result.failures, 4);
  assert.deepEqual(result.translations, [null, null, "done", null, null]);
});

test("a stop request propagates immediately and is not counted as a failure", async () => {
  let calls = 0;

  await assert.rejects(
    () => runLineFallback(["a", "b", "c"], {
      translateLine: async () => { calls += 1; throw new Error("STOP_REQUESTED"); },
    }),
    /STOP_REQUESTED/,
  );

  assert.equal(calls, 1, "a stop must not retry the remaining lines");
});

test("the abort callback sees the triggering error", async () => {
  let seen: unknown = null;
  await assert.rejects(() => runLineFallback(["a", "b", "c", "d"], {
    translateLine: async () => { throw new Error("fetch failed"); },
    onAbort: (error) => { seen = error; },
  }));

  assert.match(String((seen as Error)?.message), /fetch failed/);
});

test("the failure limit is configurable", async () => {
  let calls = 0;
  await assert.rejects(() => runLineFallback(["a", "b", "c", "d", "e"], {
    translateLine: async () => { calls += 1; throw new Error("timeout"); },
    failureLimit: 2,
  }));
  assert.equal(calls, 2);
});
