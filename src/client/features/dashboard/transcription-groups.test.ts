import test from "node:test";
import assert from "node:assert/strict";
import { fileNameOf, groupTranscriptionAttempts, retryableGroups } from "./transcription-groups.js";
import type { TranscriptionHistoryEntry } from "../../types";

function attempt(
  overrides: Partial<TranscriptionHistoryEntry> & Pick<TranscriptionHistoryEntry, "id" | "inputPath" | "startedAt">,
): TranscriptionHistoryEntry {
  return {
    outputPath: "/media/out.srt",
    model: "small",
    language: "en",
    outputFormat: "srt",
    postAction: "transcribe_only",
    status: "failed",
    finishedAt: null,
    durationSeconds: null,
    errorSummary: null,
    ...overrides,
  } as TranscriptionHistoryEntry;
}

test("repeated failures for one file collapse into a single row", () => {
  // The observed case: the same file failed four times and rendered as four
  // rows, each needing its own Retry click.
  const attempts = [
    attempt({ id: "4", inputPath: "/media/Proxmox.mp4", startedAt: "2026-07-31T04:00:00.000Z", errorSummary: "terminated" }),
    attempt({ id: "3", inputPath: "/media/Proxmox.mp4", startedAt: "2026-07-31T03:00:00.000Z", errorSummary: "fetch failed" }),
    attempt({ id: "2", inputPath: "/media/Proxmox.mp4", startedAt: "2026-07-31T02:00:00.000Z" }),
    attempt({ id: "1", inputPath: "/media/Proxmox.mp4", startedAt: "2026-07-31T01:00:00.000Z" }),
  ];

  const groups = groupTranscriptionAttempts(attempts);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].attempts.length, 4);
  assert.equal(groups[0].failedCount, 4);
  assert.equal(groups[0].latest.id, "4", "latest attempt drives the row");
  assert.equal(groups[0].title, "Proxmox.mp4");
});

test("groups are ordered by their most recent attempt", () => {
  const groups = groupTranscriptionAttempts([
    attempt({ id: "a1", inputPath: "/media/A.mp4", startedAt: "2026-07-31T01:00:00.000Z" }),
    attempt({ id: "b1", inputPath: "/media/B.mp4", startedAt: "2026-07-31T05:00:00.000Z" }),
    attempt({ id: "a2", inputPath: "/media/A.mp4", startedAt: "2026-07-31T02:00:00.000Z" }),
  ]);

  assert.deepEqual(groups.map((g) => g.inputPath), ["/media/B.mp4", "/media/A.mp4"]);
  assert.equal(groups[1].latest.id, "a2");
});

test("attempts within a group are newest first regardless of input order", () => {
  const groups = groupTranscriptionAttempts([
    attempt({ id: "old", inputPath: "/media/A.mp4", startedAt: "2026-07-31T01:00:00.000Z" }),
    attempt({ id: "new", inputPath: "/media/A.mp4", startedAt: "2026-07-31T09:00:00.000Z" }),
    attempt({ id: "mid", inputPath: "/media/A.mp4", startedAt: "2026-07-31T05:00:00.000Z" }),
  ]);

  assert.deepEqual(groups[0].attempts.map((a) => a.id), ["new", "mid", "old"]);
});

test("retry-all targets only files whose latest attempt failed", () => {
  const groups = groupTranscriptionAttempts([
    // Failed twice, then succeeded — nothing left to retry.
    attempt({ id: "r1", inputPath: "/media/Recovered.mp4", startedAt: "2026-07-31T03:00:00.000Z", status: "succeeded" }),
    attempt({ id: "r0", inputPath: "/media/Recovered.mp4", startedAt: "2026-07-31T02:00:00.000Z" }),
    attempt({ id: "f0", inputPath: "/media/Broken.mp4", startedAt: "2026-07-31T04:00:00.000Z" }),
    attempt({ id: "run", inputPath: "/media/Running.mp4", startedAt: "2026-07-31T05:00:00.000Z", status: "running" }),
  ]);

  assert.deepEqual(retryableGroups(groups).map((g) => g.inputPath), ["/media/Broken.mp4"]);
});

test("file name handles both path separators", () => {
  assert.equal(fileNameOf("/media/show/Episode 01.mkv"), "Episode 01.mkv");
  assert.equal(fileNameOf("C:\\media\\show\\Episode 01.mkv"), "Episode 01.mkv");
  assert.equal(fileNameOf("bare.mkv"), "bare.mkv");
});

test("empty history yields no groups", () => {
  assert.deepEqual(groupTranscriptionAttempts([]), []);
});
