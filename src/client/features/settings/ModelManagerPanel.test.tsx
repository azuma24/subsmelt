import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import type { WhisperModel } from "../../types";
import { ModelManagerPanel } from "./ModelManagerPanel";

function renderModels(models: WhisperModel[]) {
  return renderPage(<ModelManagerPanel enabled host={{ os: "unknown", accelerator: "cpu" }} />, [
    [["whisper-models"], { models }],
  ]);
}

test("Settings shows backend progress and a cancel action without a local download request", () => {
  const page = renderModels([
    {
      id: "tiny",
      downloaded: false,
      download: { id: "operation-id", model: "tiny", status: "running", progress: { pct: 38 } },
    },
  ]);

  assert.ok(page.text.includes("Downloading…"));
  assert.ok(page.html.includes('aria-valuenow="38"'));
  assert.ok(page.buttons.includes("Cancel"));
  assert.ok(!page.buttons.includes("Download"));
});

test("Settings keeps the download and delete controls with an older backend", () => {
  const page = renderModels([
    { id: "tiny", downloaded: false },
    { id: "small", downloaded: true },
  ]);

  assert.ok(page.buttons.includes("Download"));
  assert.ok(page.buttons.includes("Delete"));
  assert.ok(!page.buttons.includes("Cancel"));
});
