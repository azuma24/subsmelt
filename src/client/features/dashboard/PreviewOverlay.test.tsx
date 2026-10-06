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
  const page = renderPage(<PreviewOverlay isMobile={false} jobId={7} previewSearch="" setPreviewSearch={() => {}} onClose={() => {}} />, seed);

  assert.match(page.html, /aria-expanded="false"/);
  assert.ok(page.buttons.includes("Context / Plot Summary / Glossary Show A space-opera serial; keep the general's title formal."));
  assert.ok(!page.text.includes("Scene 1"), "plot body stays hidden until expanded");
  assert.ok(!page.buttons.includes("Copy plot summary"), "copy actions live inside the expanded body");
  assert.ok(page.text.includes("Hello there."));
  assert.ok(page.text.includes("肯諾比將軍。"));
});
