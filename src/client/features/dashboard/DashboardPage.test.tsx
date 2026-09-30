import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, type QuerySeed } from "../../test-render";
import type { JobRow, Task } from "../../types";
import { DashboardPage } from "./DashboardPage";

function job(id: number, name: string, status: string): JobRow {
  return {
    id,
    srt_path: `/media/Show/${name}`,
    output_path: `/media/Show/${name.replace(".en.srt", ".zh-TW.srt")}`,
    status,
    priority: 0,
    total_cues: 100,
    completed_cues: status === "done" ? 100 : 0,
    error: status === "error" ? "boom" : null,
    duration_seconds: null,
    target_lang: "Traditional Chinese",
    lang_code: "zh-TW",
    force: 0,
  };
}

const zhTask: Task = { id: 1, source_lang: "English", target_lang: "Traditional Chinese", output_pattern: "", lang_code: "zh-TW", enabled: 1, prompt_override: "" };

const configured: QuerySeed = [
  [["jobs"], { jobs: [job(1, "Episode 01.en.srt", "done"), job(2, "Episode 02.en.srt", "error"), job(3, "Episode 03.en.srt", "pending")], queueRunning: false, currentJobId: null }],
  [["tasks"], [zhTask]],
  [["settings"], { _llm_configured: true }],
];

test("a fresh install shows the setup checklist and an empty queue", () => {
  const page = renderPage(<DashboardPage isMobile={false} />, [
    [["jobs"], { jobs: [], queueRunning: false, currentJobId: null }],
    [["tasks"], []],
    [["settings"], {}],
  ]);

  assert.match(page.text, /^Dashboard /);
  assert.ok(page.text.includes("Setup checklist"));
  assert.ok(page.text.includes("LLM connection ○ Configure endpoint and model."));
  assert.ok(page.text.includes("Translation targets ○ Add at least one enabled translation target."));
  assert.ok(page.text.includes("No jobs matching filter"));
  assert.ok(page.buttons.includes("Scan Folders"));
  assert.ok(page.buttons.includes("All 0"));
});

test("queued jobs render one row each with a status glyph and label", () => {
  const page = renderPage(<DashboardPage isMobile={false} />, configured);

  assert.ok(page.text.includes("Episode 01.en.srt Traditional Chinese · zh-TW ✓ Done 100/100 cues"));
  assert.ok(page.text.includes("Episode 02.en.srt Traditional Chinese · zh-TW ✕ Error"));
  assert.ok(page.text.includes("Episode 03.en.srt Traditional Chinese · zh-TW ○ Pending"));
  assert.ok(page.text.includes("LLM connection ✓ Ready"));
  assert.ok(!page.text.includes("No jobs matching filter"));
  for (const label of ["All 3", "Pending 1", "Done 1", "Errors 1", "Retry visible errors (1)", "Clear finished"]) {
    assert.ok(page.buttons.includes(label), `missing button ${label}`);
  }
});

test("phones show all three scan and run actions inline", () => {
  const page = renderPage(<DashboardPage isMobile />, configured);

  assert.deepEqual(page.buttons.slice(0, 3), ["Preview Scan", "Scan Folders", "▶ Run All"]);
  assert.ok(page.text.includes("Episode 02.en.srt"));
});
