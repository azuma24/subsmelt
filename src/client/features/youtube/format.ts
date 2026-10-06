import type { TFunction } from "../../i18n";
import type { YoutubeBackfill, YoutubeMedia } from "../../types";

export type FollowKind = "playlist" | "channel";

// A followed channel is stored as its uploads playlist: its channel id with UU for UC.
const UPLOADS_ID_RE = /^UU[A-Za-z0-9_-]{22}$/;

export function followKind(playlistId: string): FollowKind {
  return UPLOADS_ID_RE.test(playlistId) ? "channel" : "playlist";
}

/** The YouTube page of a followed playlist or channel. */
export function followUrl(playlistId: string): string {
  return followKind(playlistId) === "channel"
    ? `https://www.youtube.com/channel/UC${playlistId.slice(2)}`
    : `https://www.youtube.com/playlist?list=${playlistId}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "6 min ago" / "in 54 min" in the UI language. */
export function relativeFromNow(iso: string, lang: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return format.format(Math.round(diff / ms), unit);
  }
  return format.format(0, "minute");
}

/** 727 → "12:07", 6793 → "1:53:13". */
export function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** "2026-08" or "2026-08-01" → "August 2026" in the UI language. */
export function monthLabel(date: string, lang: string): string {
  const [year, month] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(lang, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    Date.UTC(year, month - 1, 1),
  );
}

/** "2026-09-26" → "Sep 26", with the year when it is not this year. */
export function shortDate(date: string, lang: string, now = new Date()): string {
  const [year, month, day] = date.split("-").map(Number);
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  if (year !== now.getUTCFullYear()) options.year = "numeric";
  return new Intl.DateTimeFormat(lang, options).format(Date.UTC(year, month - 1, day));
}

const CODEC_LABEL: Record<string, string> = { h264: "H.264", vp9: "VP9", av1: "AV1" };

export function profileLabel(media: YoutubeMedia, t: TFunction): string {
  if (media.type === "audio") return t("youtube.profileAudio", { format: media.format });
  const codec = media.codec === "any" ? t("youtube.dialog.codecAny") : CODEC_LABEL[media.codec];
  return t("youtube.profileVideo", { height: media.maxHeight, codec });
}

export function keepLabel(backfill: YoutubeBackfill, t: TFunction, lang: string): string {
  switch (backfill.kind) {
    case "all":
      return t("youtube.summary.keepAll");
    case "none":
      return t("youtube.summary.keepNone");
    case "posted_since":
      return t("youtube.summary.keepPosted", { month: monthLabel(backfill.date, lang) });
    case "added_since":
      return t("youtube.summary.keepAdded", { month: monthLabel(backfill.date, lang) });
  }
}

export function availabilityLabel(availability: string | null, t: TFunction): string | null {
  return availability === "public" || availability === "unlisted" || availability === "private"
    ? t(`youtube.availability.${availability}`)
    : null;
}
