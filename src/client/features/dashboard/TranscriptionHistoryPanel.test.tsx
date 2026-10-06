import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import type { TranscriptionHistoryEntry } from "../../types";
import { TranscriptionHistoryPanel } from "./TranscriptionHistoryPanel";

function attempt(id: string, inputPath: string, status: TranscriptionHistoryEntry["status"], finishedAt: string | null): TranscriptionHistoryEntry {
  return {
    id,
    inputPath,
    outputPath: inputPath.replace(/\.mkv$/, ".srt"),
    model: "large-v3",
    language: "en",
    outputFormat: "srt",
    postAction: "transcribe_only",
    status,
    startedAt: "2026-10-03T08:12:04.000Z",
    finishedAt,
    durationSeconds: finishedAt ? 457 : null,
    errorSummary: status === "failed" ? "connect ECONNREFUSED 127.0.0.1:8001" : null,
  };
}

const attempts = [
  attempt("h1", "/media/Docs/Lecture.mkv", "succeeded", "2026-10-03T08:19:41.000Z"),
  attempt("h2", "/media/Show/Episode 03.mkv", "failed", "2026-10-02T21:40:09.000Z"),
  attempt("h3", "/media/Show/Episode 03.mkv", "failed", "2026-10-02T21:30:05.000Z"),
];

test("history rows show translated statuses and a relative time with the full stamp as a tooltip", () => {
  const page = renderPage(
    <TranscriptionHistoryPanel attempts={attempts} transcribingPath={null} isRetryPending={false} isTranscribePending={false} onRetry={() => {}} />,
  );

  assert.ok(page.text.includes("Lecture.mkv large-v3 • en • SRT • transcribe only"));
  assert.match(page.text, /Lecture\.mkv .* (\d+[smhd]( \d+m)? ago|just now) Succeeded Retry/);
  assert.ok(page.text.includes("Failed"));
  assert.doesNotMatch(page.text, /\bsucceeded\b|\bfailed\b/, "raw status values are not shown");
  assert.doesNotMatch(page.text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "raw ISO timestamps are not shown");
  assert.match(page.html, /title="[^"]*2026[^"]*"/, "the full timestamp is kept as a tooltip");
});
