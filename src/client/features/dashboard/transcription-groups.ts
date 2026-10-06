import type { TranscriptionHistoryEntry } from "../../types";

/**
 * Collapse transcription history into one row per source file.
 *
 * The raw history is an attempt log, so a file that fails repeatedly appears as
 * N near-identical rows — each needing its own Retry click. Grouping by input
 * path turns that into one row carrying the latest outcome and an attempt count,
 * with the individual attempts available on expand.
 */

export interface TranscriptionGroup {
  /** Source media path — the group key. */
  inputPath: string;
  /** File name for display. */
  title: string;
  /** Most recent attempt; drives the row's status and Retry action. */
  latest: TranscriptionHistoryEntry;
  /** Every attempt for this file, newest first. */
  attempts: TranscriptionHistoryEntry[];
  /** How many of them failed. */
  failedCount: number;
}

function startedAtMs(entry: TranscriptionHistoryEntry): number {
  const parsed = Date.parse(entry.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function fileNameOf(inputPath: string): string {
  return inputPath.split(/[\\/]/).pop() || inputPath;
}

export function groupTranscriptionAttempts(
  attempts: TranscriptionHistoryEntry[],
): TranscriptionGroup[] {
  const byPath = new Map<string, TranscriptionHistoryEntry[]>();
  for (const attempt of attempts) {
    const existing = byPath.get(attempt.inputPath);
    if (existing) existing.push(attempt);
    else byPath.set(attempt.inputPath, [attempt]);
  }

  const groups: TranscriptionGroup[] = [];
  for (const [inputPath, entries] of byPath) {
    // Newest first so `latest` is the head and the expanded list reads top-down.
    const ordered = [...entries].sort((a, b) => startedAtMs(b) - startedAtMs(a));
    groups.push({
      inputPath,
      title: fileNameOf(inputPath),
      latest: ordered[0],
      attempts: ordered,
      failedCount: ordered.filter((entry) => entry.status === "failed").length,
    });
  }

  return groups.sort((a, b) => startedAtMs(b.latest) - startedAtMs(a.latest));
}

/**
 * Groups whose most recent attempt failed — the ones "Retry all failed" acts on.
 * A file that failed twice and then succeeded is deliberately excluded: there is
 * nothing left to retry.
 */
export function retryableGroups(groups: TranscriptionGroup[]): TranscriptionGroup[] {
  return groups.filter((group) => group.latest.status === "failed");
}
