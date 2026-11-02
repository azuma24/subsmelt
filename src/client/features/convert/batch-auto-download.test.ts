import test from "node:test";
import assert from "node:assert/strict";
import type { ConvertBatch } from "../../api";
import { shouldAutoDownload } from "./batch-auto-download";

const completed = { id: "new", status: "done" } as ConvertBatch;
test("only a newly submitted completed batch auto-downloads in the current page", () => {
  assert.equal(shouldAutoDownload(completed, "new"), true);
  assert.equal(shouldAutoDownload(completed, null), false); // Reopened tab or old history.
  assert.equal(shouldAutoDownload(completed, "other"), false);
  assert.equal(shouldAutoDownload({ ...completed, status: "running" }, "new"), false);
});
