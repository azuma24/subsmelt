import type { TFunction } from "../../i18n";
import type {
  YoutubePipeline,
  YoutubeSubtitlePlan,
  YoutubeVideo,
  YoutubeVideoAction,
  YoutubeVideoStatus,
} from "../../types";
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
const awaitingSubtitles = (video: Pick<YoutubeVideo, "status" | "pct">) =>
  video.status === "transcribing" && video.pct === undefined;

/** What a shared GPU is holding back right now. */
export interface GpuHold {
  /** A translation batch runs, so Whisper waits. */
  whisper: boolean;
  /** Transcriptions are pending, so translation waits. */
  translation: boolean;
}

export const NO_HOLD: GpuHold = { whisper: false, translation: false };

export function gpuHold(pipeline: YoutubePipeline | undefined): GpuHold {
  if (!pipeline?.gpu.shared) return NO_HOLD;
  return { whisper: pipeline.gpu.translationRunning, translation: pipeline.gpu.held };
}

export function videoStatusDescriptor(
  video: Pick<YoutubeVideo, "status" | "pct">,
  t: TFunction,
  hold: GpuHold = NO_HOLD,
): StatusDescriptor {
  if (awaitingSubtitles(video))
    return {
      glyph: "··",
      tone: "warn",
      label: t(hold.whisper ? "youtube.status.gpuWait" : "youtube.status.subtitlesNext"),
    };
  if (video.status === "translating" && hold.translation)
    return { glyph: "··", tone: "warn", label: t("youtube.status.translationHeld") };
  const view = STATUS_VIEW[video.status];
  return { glyph: view.glyph, tone: view.tone, label: t(`youtube.status.${video.status}`) };
}

export function videoActions(status: YoutubeVideoStatus): readonly YoutubeVideoAction[] {
  return STATUS_VIEW[status].actions;
}

/** Videos a pick can send to download: the ones a backfill or a skip left out. */
export function pickableVideos(videos: YoutubeVideo[]): YoutubeVideo[] {
  return videos.filter((video) => video.status === "skipped");
}

/** "Download now" jumps the queue for a video on its way; "Download" brings back a skipped one. */
export function videoActionLabelKey(status: YoutubeVideoStatus, action: YoutubeVideoAction): string {
  if (action === "download") return status === "skipped" ? "youtube.actions.download" : "youtube.actions.downloadNow";
  return `youtube.actions.${action}`;
}

export function videoPipeline(
  video: Pick<YoutubeVideo, "status" | "pct" | "media_path">,
  hold: GpuHold = NO_HOLD,
): readonly PipeStep[] {
  if (video.status === "failed" && video.media_path) return ["done", "fail", "", ""];
  if (awaitingSubtitles(video)) return ["done", "wait", "", ""];
  if (video.status === "translating" && hold.translation) return ["done", "done", "wait", ""];
  return STATUS_VIEW[video.status].pipe;
}

/** How many of `videos` sit in each status. */
export function statusCounts(
  videos: readonly Pick<YoutubeVideo, "status">[],
): Partial<Record<YoutubeVideoStatus, number>> {
  const counts: Partial<Record<YoutubeVideoStatus, number>> = {};
  for (const video of videos) counts[video.status] = (counts[video.status] ?? 0) + 1;
  return counts;
}

/** Video counts per filter tab. "all" leaves skipped videos out, as its list does. */
export function countByFilter(
  byStatus: Partial<Record<YoutubeVideoStatus, number>>,
): Record<VideoFilter | "all", number> {
  const counts: Record<VideoFilter | "all", number> = { all: 0, run: 0, wait: 0, done: 0, bad: 0, off: 0 };
  for (const [status, n] of Object.entries(byStatus) as [YoutubeVideoStatus, number][]) {
    const filter = STATUS_VIEW[status].filter;
    counts[filter] += n;
    if (filter !== "off") counts.all += n;
  }
  return counts;
}

/** The All tab's groups in order: what is moving, what needs a look, what waits, what is finished. */
export const ALL_GROUPS: readonly VideoFilter[] = ["run", "bad", "wait", "done"];

/**
 * The videos a tab lists. All lists them group by group, in playlist order
 * within a group, so its first page starts with what is moving.
 */
export function filterVideos(videos: YoutubeVideo[], filter: VideoFilter | "all", query: string): YoutubeVideo[] {
  const needle = query.trim().toLowerCase();
  const matching = videos.filter((video) => {
    const group = STATUS_VIEW[video.status].filter;
    if (filter === "all" ? group === "off" : group !== filter) return false;
    return !needle || `${video.title} ${video.channel ?? ""}`.toLowerCase().includes(needle);
  });
  if (filter !== "all") return matching;
  const rank = (video: YoutubeVideo) => ALL_GROUPS.indexOf(STATUS_VIEW[video.status].filter);
  return matching.sort((a, b) => rank(a) - rank(b));
}

/** "zh-Hant" reads "ZH-Hant": the language upper case, the script or region as written. */
const spokenLabel = (key: string) => key.replace(/^[a-z]+/, (base) => base.toUpperCase());

/**
 * One line saying where each subtitle came from: "EN = captions · CHT cc
 * from creator · JPN → translated". Tasks are named by their language code.
 */
export function subtitleSummary(
  {
    subtitles: plan,
    transcript_source: source,
    status,
  }: { subtitles: YoutubeSubtitlePlan; transcript_source: string | null; status: YoutubeVideoStatus },
  langCodes: ReadonlyMap<number, string>,
  hold: GpuHold,
  t: TFunction,
): string {
  const transcript = plan.spoken
    ? t(source === "youtube_captions" ? "youtube.subs.captions" : "youtube.subs.transcript", {
        lang: spokenLabel(plan.spoken),
      })
    : t("youtube.subs.transcriptOnly");
  const translation =
    status !== "translating"
      ? "youtube.subs.translated"
      : hold.translation
        ? "youtube.subs.waiting"
        : "youtube.subs.translating";
  const routes = plan.routes.map(({ taskId, kind }) => {
    const lang = (langCodes.get(taskId) ?? `#${taskId}`).toUpperCase();
    if (kind === "same") return t("youtube.subs.transcript", { lang });
    if (kind === "captions") return t("youtube.subs.creator", { lang });
    return t(translation, { lang });
  });
  return [transcript, ...routes].join(" · ");
}
