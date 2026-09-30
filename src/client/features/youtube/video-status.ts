import type { TFunction } from "i18next";
import type { YoutubeVideo, YoutubeVideoStatus } from "../../types";
import type { StatusDescriptor, StatusTone } from "../../ui/primitives";

/** The filter tabs, in display order after "all". */
export const VIDEO_FILTERS = ["run", "wait", "done", "bad", "off"] as const;
export type VideoFilter = (typeof VIDEO_FILTERS)[number];

interface StatusView {
  glyph: string;
  tone: StatusTone;
  filter: VideoFilter;
}

const STATUS_VIEW: Record<YoutubeVideoStatus, StatusView> = {
  new: { glyph: "+", tone: "neutral", filter: "wait" },
  queued: { glyph: "··", tone: "neutral", filter: "wait" },
  waiting: { glyph: "◷", tone: "neutral", filter: "wait" },
  downloading: { glyph: "↓", tone: "run", filter: "run" },
  transcribing: { glyph: "≋", tone: "run", filter: "run" },
  translating: { glyph: "⇄", tone: "run", filter: "run" },
  done: { glyph: "✓", tone: "ok", filter: "done" },
  failed: { glyph: "✕", tone: "bad", filter: "bad" },
  unavailable: { glyph: "∅", tone: "bad", filter: "bad" },
  skipped: { glyph: "–", tone: "neutral", filter: "off" },
};

export function videoFilterOf(status: YoutubeVideoStatus): VideoFilter {
  return STATUS_VIEW[status].filter;
}

export function videoStatusDescriptor(status: YoutubeVideoStatus, t: TFunction): StatusDescriptor {
  const view = STATUS_VIEW[status];
  return { glyph: view.glyph, tone: view.tone, label: t(`youtube.status.${status}`) };
}

/** Video counts per filter tab. "all" leaves skipped videos out, as its list does. */
export function countByFilter(byStatus: Partial<Record<YoutubeVideoStatus, number>>): Record<VideoFilter | "all", number> {
  const counts: Record<VideoFilter | "all", number> = { all: 0, run: 0, wait: 0, done: 0, bad: 0, off: 0 };
  for (const [status, n] of Object.entries(byStatus) as [YoutubeVideoStatus, number][]) {
    const filter = STATUS_VIEW[status].filter;
    counts[filter] += n;
    if (filter !== "off") counts.all += n;
  }
  return counts;
}

export function filterVideos(videos: YoutubeVideo[], filter: VideoFilter | "all", query: string): YoutubeVideo[] {
  const needle = query.trim().toLowerCase();
  return videos.filter((video) => {
    const group = STATUS_VIEW[video.status].filter;
    if (filter === "all" ? group === "off" : group !== filter) return false;
    return !needle || `${video.title} ${video.channel ?? ""}`.toLowerCase().includes(needle);
  });
}
