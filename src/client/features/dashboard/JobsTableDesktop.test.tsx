import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, type QuerySeed } from "../../test-render";
import type { JobRow } from "../../types";
import { JobsTableDesktop } from "./JobsTableDesktop";

function job(id: number, name: string, status: string): JobRow {
  return {
    id,
    srt_path: `/media/Show/${name}`,
    output_path: `/media/Show/${name.replace(".en.srt", ".zh-TW.srt")}`,
    status,
    priority: 0,
    total_cues: 100,
    completed_cues: status === "done" ? 100 : 40,
    error: status === "error" ? "boom" : null,
    duration_seconds: null,
    target_lang: "Traditional Chinese",
    lang_code: "zh-TW",
    force: 0,
  };
}

const jobs = [job(1, "Episode 01.en.srt", "done"), job(2, "Episode 02.en.srt", "translating"), job(3, "Episode 03.en.srt", "pending")];
const seed: QuerySeed = [[["jobs"], { jobs, queueRunning: true, currentJobId: 2 }]];

/** Splits the rendered table into its grid rows: header first, then one per job. */
function gridRows(html: string): string[] {
  const parts = html.split(/<div[^>]*role="row"[^>]*grid-template-columns[^>]*>/);
  return parts.slice(1);
}

function renderTable() {
  return renderPage(
    <JobsTableDesktop jobs={jobs} currentJobId={2} selectedIds={new Set()} setSelectedIds={() => {}} onPreview={() => {}} onOpenLogs={() => {}} onOpenDetails={() => {}} />,
    seed,
  );
}

test("each job renders its cells inside one grid row", () => {
  const rows = gridRows(renderTable().html);

  assert.equal(rows.length, 1 + jobs.length, "header row plus one grid row per job");
  assert.match(rows[1], /Episode 01\.en\.srt[\s\S]*Done[\s\S]*100\/100 cues/);
  assert.match(rows[2], /Episode 02\.en\.srt[\s\S]*Active[\s\S]*aria-valuenow="40"/);
  assert.match(rows[3], /Episode 03\.en\.srt[\s\S]*Pending/);
});

test("the active job's row is highlighted and the others are not", () => {
  const html = renderTable().html;
  const rowTags = Array.from(html.matchAll(/<div[^>]*role="row"[^>]*grid-template-columns[^>]*>/g), (m) => m[0]);

  assert.equal(rowTags.length, 1 + jobs.length);
  assert.match(rowTags[2], /bg-\[var\(--accent-dim\)\]/, "translating job row");
  assert.doesNotMatch(rowTags[1], /accent-dim/, "done job row");
  assert.doesNotMatch(rowTags[3], /accent-dim/, "pending job row");
});
