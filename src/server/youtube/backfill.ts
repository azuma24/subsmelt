import type { Backfill } from "./playlists.js";

export interface BackfillEntry {
  videoId: string;
  /** YYYY-MM-DD, rounded by YouTube in a flat listing. */
  publishedAt: string | null;
}

export interface BackfillDeps {
  /** Exact upload date (YYYY-MM-DD) from one per-video metadata call, or null when unknown. */
  exactUploadDate: (videoId: string) => Promise<string | null>;
  /** Video id to the date it was added to the playlist. Required for added_since. */
  addedDates: Map<string, string> | null;
  today: string;
}

export interface BackfillSelection {
  selected: Set<string>;
  /** Exact upload dates looked up while deciding, to store in place of the rounded ones. */
  exactDates: Map<string, string>;
}

const DAY_MS = 86_400_000;

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/**
 * How much older than its rounded date a video can be. YouTube floors "N units
 * ago", showing days under a week, weeks under a month, months under a year,
 * then years, so the real date lies within one step before the rounded one.
 */
function roundingStepDays(ageDays: number): number {
  if (ageDays < 7) return 1;
  if (ageDays < 30) return 7;
  if (ageDays < 365) return 31;
  return 366;
}

/** True when a rounded publish date could fall on either side of the cutoff. A day of slack covers time zones. */
export function needsExactDate(publishedAt: string | null, cutoff: string, today: string): boolean {
  if (!publishedAt) return true;
  const published = dayNumber(publishedAt);
  const limit = dayNumber(cutoff);
  const step = roundingStepDays(dayNumber(today) - published);
  return published >= limit - 1 && published - step < limit;
}

/** Decides which videos already in a playlist the backfill filter keeps. */
export async function selectBackfill(
  backfill: Backfill,
  entries: BackfillEntry[],
  deps: BackfillDeps,
): Promise<BackfillSelection> {
  const exactDates = new Map<string, string>();
  switch (backfill.kind) {
    case "all":
      return { selected: new Set(entries.map((e) => e.videoId)), exactDates };
    case "none":
      return { selected: new Set(), exactDates };
    case "added_since": {
      const added = deps.addedDates;
      if (!added) throw new Error("Added since needs a working YouTube Data API key");
      const selected = entries.filter((e) => (added.get(e.videoId) ?? "") >= backfill.date).map((e) => e.videoId);
      return { selected: new Set(selected), exactDates };
    }
    case "posted_since": {
      const selected = new Set<string>();
      for (const entry of entries) {
        let date = entry.publishedAt;
        if (needsExactDate(date, backfill.date, deps.today)) {
          const exact = await deps.exactUploadDate(entry.videoId);
          if (exact) {
            exactDates.set(entry.videoId, exact);
            date = exact;
          }
        }
        if (date && date >= backfill.date) selected.add(entry.videoId);
      }
      return { selected, exactDates };
    }
  }
}
