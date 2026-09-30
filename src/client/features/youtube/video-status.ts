import type { TFunction } from "i18next";
import type { YoutubeVideo, YoutubeVideoAction, YoutubeVideoStatus } from "../../types";
import type { StatusDescriptor, StatusTone } from "../../ui/primitives";

/** The filter tabs, in display order after "all". */
export const VIDEO_FILTERS = ["run", "wait", "done", "bad", "off"] as const;
export type VideoFilter = (typeof VIDEO_FILTERS)[number];

/** One segment of the row's pipeline bar: Download, Subtitles, Translate, Note. */
export type PipeStep = "" | "done" | "now" | "wait" | "fail";

interface StatusView {
  glyph: string;
  tone: StatusTone;
  filter: VideoFilter;
  /** Row actions, mirroring USER_ACTIONS in src/server/youtube/video-status.ts. */
  actions: readonly YoutubeVideoAction[];
  pipe: readonly PipeStep[];
}

const NOT_STARTED: readonly PipeStep[] = ["", "", "", ""];

// Unavailable sits with skipped: nothing to do and nothing kept, so neither Kept nor Needs attention counts it.
const STATUS_VIEW: Record<YoutubeVideoStatus, StatusView> = {
  new: { glyph: "+", tone: "neutral", filter: "wait", actions: ["download", "skip"], pipe: NOT_STARTED },
  queued: { glyph: "··", tone: "neutral", filter: "wait", actions: ["download", "skip"], pipe: NOT_STARTED },
  waiting: { glyph: "◷", tone: "warn", filter: "wait", actions: ["download", "skip"], pipe: ["wait", "", "", ""] },
  downloading: { glyph: "↓", tone: "run", filter: "run", actions: [], pipe: ["now", "", "", ""] },
  transcribing: { glyph: "≋", tone: "run", filter: "run", actions: [], pipe: ["done", "now", "", ""] },
  translating: { glyph: "⇄", tone: "run", filter: "run", actions: [], pipe: ["done", "done", "now", ""] },
  done: { glyph: "✓", tone: "ok", filter: "done", actions: [], pipe: ["done", "done", "done", "done"] },
  failed: { glyph: "✕", tone: "bad", filter: "bad", actions: ["retry", "skip"], pipe: ["fail", "", "", ""] },
  unavailable: { glyph: "∅", tone: "neutral", filter: "off", actions: ["retry"], pipe: NOT_STARTED },
  skipped: { glyph: "–", tone: "neutral", filter: "off", actions: ["download"], pipe: NOT_STARTED },
};

export function videoFilterOf(status: YoutubeVideoStatus): VideoFilter {
  return STATUS_VIEW[status].filter;
}

/** A transcribing video with no live progress is waiting for its subtitle step, not running it. */
const awaitingSubtitles = (video: Pick<YoutubeVideo, "status" | "pct">) => video.status === "transcribing" && video.pct === undefined;

export function videoStatusDescriptor(video: Pick<YoutubeVideo, "status" | "pct">, t: TFunction): StatusDescriptor {
  if (awaitingSubtitles(video)) return { glyph: "··", tone: "warn", label: t("youtube.status.subtitlesNext") };
  const view = STATUS_VIEW[video.status];
  return { glyph: view.glyph, tone: view.tone, label: t(`youtube.status.${video.status}`) };
}

export function videoActions(status: YoutubeVideoStatus): readonly YoutubeVideoAction[] {
  return STATUS_VIEW[status].actions;
}

/** "Download now" jumps the queue for a video on its way; "Download" brings back a skipped one. */
export function videoActionLabelKey(status: YoutubeVideoStatus, action: YoutubeVideoAction): string {
  if (action === "download") return status === "skipped" ? "youtube.actions.download" : "youtube.actions.downloadNow";
  return `youtube.actions.${action}`;
}

export function videoPipeline(video: Pick<YoutubeVideo, "status" | "pct" | "media_path">): readonly PipeStep[] {
  if (video.status === "failed" && video.media_path) return ["done", "fail", "", ""];
  if (awaitingSubtitles(video)) return ["done", "wait", "", ""];
  return STATUS_VIEW[video.status].pipe;
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
