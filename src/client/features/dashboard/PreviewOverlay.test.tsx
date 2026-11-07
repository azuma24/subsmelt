import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, type QuerySeed } from "../../test-render";
import type { JobPreview } from "../../types";
import { PreviewOverlay } from "./PreviewOverlay";

const analysis = [
  "### 🎬 Context",
  "A space-opera serial; keep the general's title formal.",
  "",
  "### 📝 Plot Summary",
  "Scene 1: the hero lands on the platform.",
  "Scene 2: the duel begins.",
  "",
  "### 📚 Glossary",
  "- General: 將軍",
].join("\n");

const preview: JobPreview = {
  targetLang: "Traditional Chinese",
  srtPath: "/media/Show/Episode 01.en.srt",
  outputPath: "/media/Show/Episode 01.zh-TW.srt",
  analysis,
  totalLines: 2,
  lines: [
    { index: 1, original: "Hello there.", translated: "你好啊。", start: 1000, end: 3000 },
    { index: 2, original: "General Kenobi.", translated: "肯諾比將軍。", start: 4000, end: 6000 },
  ],
};

const seed: QuerySeed = [[["job-preview", 7], preview]];

test("the analysis opens collapsed to a heading and a one-line teaser, with the cues visible", () => {
  const page = renderPage(
    <PreviewOverlay jobId={7} previewSearch="" setPreviewSearch={() => {}} onClose={() => {}} />,
    seed,
  );

  assert.match(page.html, /aria-expanded="false"/);
  assert.ok(
    page.buttons.includes(
      "Context / Plot Summary / Glossary Show A space-opera serial; keep the general's title formal.",
    ),
  );
  assert.ok(!page.text.includes("Scene 1"), "plot body stays hidden until expanded");
  assert.ok(!page.buttons.includes("Copy plot summary"), "copy actions live inside the expanded body");
  assert.ok(page.text.includes("Hello there."));
  assert.ok(page.text.includes("肯諾比將軍。"));
});

test("subtitle warnings, highlights, and issue navigation require opt-in", () => {
  const preview = {
    srtPath: "/media/Example.srt",
    totalLines: 1,
    lines: [{ index: 1, start: 0, end: 1000, original: "Text", translated: "" }],
    quality: { original: [], translated: [{ code: "missingCue", cue: 1 }] },
  };
  const render = (settings: Record<string, unknown>) =>
    renderPage(<PreviewOverlay jobId={1} previewSearch="" setPreviewSearch={() => {}} onClose={() => {}} />, [
      [["job-preview", 1], preview],
      [["settings"], settings],
    ]);
  for (const settings of [{}, { show_subtitle_warnings: "0" }]) {
    const page = render(settings);
    assert.doesNotMatch(page.text, /Translated subtitle warnings|Jump to next issue/);
    assert.match(page.html, /id="preview-line-1" class=""/);
  }
  const enabled = render({ show_subtitle_warnings: "1" });
  assert.match(enabled.text, /Translated subtitle warnings 1/);
  assert.match(enabled.html, /id="preview-line-1" class="bg-warning-soft"/);
  assert.ok(enabled.buttons.includes("Jump to next issue"));
});
