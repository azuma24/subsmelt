import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARTIAL_SUFFIX, partialOutputPath } from "./engine.js";
import { retryTranslate } from "./ai-client.js";

test("partial translations are written beside the output, not onto it", () => {
  const output = "/media/show/Episode 01.chi.srt";
  const partial = partialOutputPath(output);

  assert.equal(partial, `${output}${PARTIAL_SUFFIX}`);
  assert.notEqual(partial, output);
  // The queue skips a job when its output_path already exists, so an in-flight
  // translation must never occupy that path — that is what made interrupted
  // jobs come back as "output already exists" with a truncated file.
  assert.ok(partial.startsWith(output));
});

test("renaming a partial onto the output is atomic and leaves no partial behind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-partial-"));
  const output = path.join(dir, "Episode 01.chi.srt");
  const partial = partialOutputPath(output);

  fs.writeFileSync(partial, "partial content", "utf8");
  assert.equal(fs.existsSync(output), false, "output must not exist mid-run");

  fs.renameSync(partial, output);

  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.readFileSync(output, "utf8"), "partial content");
});

test("retryTranslate reports the real attempt budget to onRetry", async () => {
  const seen: Array<{ attempt: number; max?: number }> = [];

  await assert.rejects(
    retryTranslate(
      async () => {
        throw new Error("timeout");
      },
      2,
      1,
      (attempt, _error, _backoff, maxRetries) => seen.push({ attempt, max: maxRetries }),
    ),
  );

  // Two attempts total: the first reports a retry, the second throws. The
  // reported max must be the real budget — the queue log used to hardcode "/5".
  assert.deepEqual(seen, [{ attempt: 1, max: 2 }]);
});

test("retryTranslate stops immediately on a non-retryable error", async () => {
  let calls = 0;

  await assert.rejects(
    retryTranslate(
      async () => {
        calls += 1;
        const error: any = new Error("invalid api key");
        error.status = 401;
        throw error;
      },
      5,
      1,
    ),
  );

  assert.equal(calls, 1);
});
