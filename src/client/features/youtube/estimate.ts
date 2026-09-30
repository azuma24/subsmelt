import type { YoutubeBackfill, YoutubeMedia, YoutubePreviewEntry } from "../../types";

// Rough sizes from yt-dlp downloads of real videos, in GB per hour of video.
const AUDIO_GB_PER_HOUR = 0.058;
const VIDEO_GB_PER_HOUR: Record<number, number> = { 480: 0.25, 720: 0.5, 1080: 0.9, 1440: 1.8, 2160: 4.0 };

export interface SelectionEstimate {
  videos: number;
  hours: number;
  gigabytes: number;
  /** Counted from YouTube's rounded post dates; the real set is decided with exact dates. */
  approximate: boolean;
}

function selectedEntries(entries: YoutubePreviewEntry[], backfill: YoutubeBackfill): YoutubePreviewEntry[] {
  switch (backfill.kind) {
    case "all":
      return entries;
    case "none":
      return [];
    case "posted_since":
      return entries.filter((e) => e.posted !== null && e.posted >= backfill.date);
    case "added_since":
      return entries.filter((e) => e.added !== null && e.added >= backfill.date);
  }
}

export function estimateSelection(entries: YoutubePreviewEntry[], backfill: YoutubeBackfill, media: YoutubeMedia): SelectionEstimate {
  const rows = selectedEntries(entries, backfill);
  const hours = rows.reduce((sum, e) => sum + (e.durationS ?? 0), 0) / 3600;
  const rate = media.type === "audio" ? AUDIO_GB_PER_HOUR : VIDEO_GB_PER_HOUR[media.maxHeight];
  return { videos: rows.length, hours, gigabytes: hours * rate, approximate: backfill.kind === "posted_since" };
}

/** "YYYY-MM" to the number of videos posted that month, from rounded dates. */
export function postedPerMonth(entries: YoutubePreviewEntry[]): Map<string, number> {
  const months = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.posted) continue;
    const month = entry.posted.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + 1);
  }
  return months;
}

export function formatGigabytes(gb: number): string {
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}
