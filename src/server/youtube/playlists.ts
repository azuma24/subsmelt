import { getSetting, setSetting } from "../config.js";
import { normalizeMediaSubfolder } from "../media-paths.js";
import type { Parsed } from "../routes/validation.js";
import { isPlaylistId } from "./urls.js";

export const PLAYLISTS_SETTING = "youtube_playlists";

export type Backfill =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "posted_since"; date: string }
  | { kind: "added_since"; date: string };

export type MediaProfile =
  | { type: "video"; maxHeight: VideoHeight; codec: VideoCodec; container: VideoContainer }
  | { type: "audio"; format: AudioFormat };

const VIDEO_HEIGHTS = [480, 720, 1080, 1440, 2160] as const;
const VIDEO_CODECS = ["h264", "vp9", "av1", "any"] as const;
const VIDEO_CONTAINERS = ["mp4", "mkv"] as const;
const AUDIO_FORMATS = ["m4a", "opus"] as const;
const MODES = ["auto", "manual"] as const;
const CAPTION_SOURCES = ["prefer_youtube", "whisper_only"] as const;
export const MIN_CHECK_MINUTES = 15;
const DEFAULT_CHECK_MINUTES = 60;
const MAX_CHECK_MINUTES = 7 * 24 * 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type VideoHeight = (typeof VIDEO_HEIGHTS)[number];
type VideoCodec = (typeof VIDEO_CODECS)[number];
type VideoContainer = (typeof VIDEO_CONTAINERS)[number];
type AudioFormat = (typeof AUDIO_FORMATS)[number];

export interface YoutubePlaylist {
  id: string;
  title: string;
  folder: string;
  enabled: boolean;
  mode: (typeof MODES)[number];
  backfill: Backfill;
  media: MediaProfile;
  captions: (typeof CAPTION_SOURCES)[number];
  subtitleTaskIds: number[];
  checkEveryMinutes: number;
  /** For a channel: whether its Shorts and live streams are followed too. Ignored for a playlist. */
  include: ChannelInclude;
}

export interface ChannelInclude {
  shorts: boolean;
  live: boolean;
}

/** The fields a user sets when following or editing. id and title come from YouTube. */
export type PlaylistFields = Omit<YoutubePlaylist, "id" | "title">;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string | number>(options: readonly T[], v: unknown): v is T => options.includes(v as T);

function isPastOrTodayDate(value: unknown, today: string): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value <= today;
}

export function parseBackfill(value: unknown, today: string): Parsed<Backfill> {
  if (!isObj(value)) return { ok: false, error: "backfill must be an object" };
  if (value.kind === "all" || value.kind === "none") return { ok: true, value: { kind: value.kind } };
  if (value.kind === "posted_since" || value.kind === "added_since") {
    if (!isPastOrTodayDate(value.date, today)) return { ok: false, error: "backfill.date must be a YYYY-MM-DD date no later than today" };
    return { ok: true, value: { kind: value.kind, date: value.date } };
  }
  return { ok: false, error: "backfill.kind must be all, none, posted_since or added_since" };
}

function parseMedia(value: unknown): Parsed<MediaProfile> {
  if (!isObj(value)) return { ok: false, error: "media must be an object" };
  if (value.type === "audio") {
    if (!oneOf(AUDIO_FORMATS, value.format)) return { ok: false, error: "media.format must be m4a or opus" };
    return { ok: true, value: { type: "audio", format: value.format } };
  }
  if (value.type === "video") {
    if (!oneOf(VIDEO_HEIGHTS, value.maxHeight)) return { ok: false, error: "media.maxHeight must be 480, 720, 1080, 1440 or 2160" };
    if (!oneOf(VIDEO_CODECS, value.codec)) return { ok: false, error: "media.codec must be h264, vp9, av1 or any" };
    if (!oneOf(VIDEO_CONTAINERS, value.container)) return { ok: false, error: "media.container must be mp4 or mkv" };
    return { ok: true, value: { type: "video", maxHeight: value.maxHeight, codec: value.codec, container: value.container } };
  }
  return { ok: false, error: "media.type must be audio or video" };
}

function parseTaskIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every((id) => Number.isSafeInteger(id) && id > 0)) return null;
  return [...new Set(value as number[])];
}

/**
 * Validates the user-editable fields. `base` supplies anything the body leaves
 * out, so an edit can send only what changed; a follow passes the defaults.
 */
export function parsePlaylistFields(body: unknown, base: PlaylistFields, today: string): Parsed<PlaylistFields> {
  if (!isObj(body)) return { ok: false, error: "Request body must be a JSON object" };
  const out: PlaylistFields = { ...base };

  if (body.folder !== undefined) {
    const folder = typeof body.folder === "string" ? normalizeMediaSubfolder(body.folder) : null;
    if (!folder) return { ok: false, error: "folder must be a relative folder name" };
    out.folder = folder;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
    out.enabled = body.enabled;
  }
  if (body.mode !== undefined) {
    if (!oneOf(MODES, body.mode)) return { ok: false, error: "mode must be auto or manual" };
    out.mode = body.mode;
  }
  if (body.captions !== undefined) {
    if (!oneOf(CAPTION_SOURCES, body.captions)) return { ok: false, error: "captions must be prefer_youtube or whisper_only" };
    out.captions = body.captions;
  }
  if (body.backfill !== undefined) {
    const backfill = parseBackfill(body.backfill, today);
    if (!backfill.ok) return backfill;
    out.backfill = backfill.value;
  }
  if (body.media !== undefined) {
    const media = parseMedia(body.media);
    if (!media.ok) return media;
    out.media = media.value;
  }
  if (body.subtitleTaskIds !== undefined) {
    const ids = parseTaskIds(body.subtitleTaskIds);
    if (!ids) return { ok: false, error: "subtitleTaskIds must be an array of task ids" };
    out.subtitleTaskIds = ids;
  }
  if (body.checkEveryMinutes !== undefined) {
    const minutes = body.checkEveryMinutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_CHECK_MINUTES || minutes > MAX_CHECK_MINUTES) {
      return { ok: false, error: `checkEveryMinutes must be a whole number from ${MIN_CHECK_MINUTES} to ${MAX_CHECK_MINUTES}` };
    }
    out.checkEveryMinutes = minutes;
  }
  if (body.include !== undefined) {
    const include = body.include;
    if (!isObj(include) || typeof include.shorts !== "boolean" || typeof include.live !== "boolean") {
      return { ok: false, error: "include must have shorts and live set to true or false" };
    }
    out.include = { shorts: include.shorts, live: include.live };
  }
  return { ok: true, value: out };
}

export function defaultPlaylistFields(folder: string): PlaylistFields {
  return {
    folder,
    enabled: true,
    mode: "auto",
    backfill: { kind: "none" },
    media: { type: "audio", format: "m4a" },
    captions: "prefer_youtube",
    subtitleTaskIds: [],
    checkEveryMinutes: DEFAULT_CHECK_MINUTES,
    include: { shorts: false, live: false },
  };
}

/** A folder name made from a playlist title: path separators and characters Windows refuses become spaces. */
export function folderFromTitle(title: string, id: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "");
  return normalizeMediaSubfolder(cleaned.slice(0, 80)) ?? id;
}

/** Parses the stored setting, dropping entries that no longer validate rather than failing every read. */
export function parseStoredPlaylists(raw: string): YoutubePlaylist[] {
  let data: unknown;
  try {
    data = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const playlists: YoutubePlaylist[] = [];
  for (const entry of data) {
    if (!isObj(entry) || typeof entry.id !== "string" || !isPlaylistId(entry.id)) continue;
    const title = typeof entry.title === "string" ? entry.title : entry.id;
    const fields = parsePlaylistFields(entry, defaultPlaylistFields(folderFromTitle(title, entry.id)), "9999-12-31");
    if (fields.ok) playlists.push({ id: entry.id, title, ...fields.value });
  }
  return playlists;
}

export function readPlaylists(): YoutubePlaylist[] {
  return parseStoredPlaylists(getSetting(PLAYLISTS_SETTING));
}

export function writePlaylists(playlists: YoutubePlaylist[]): void {
  setSetting(PLAYLISTS_SETTING, JSON.stringify(playlists));
}

export function findPlaylist(id: string): YoutubePlaylist | undefined {
  return readPlaylists().find((p) => p.id === id);
}

/** Replaces the playlist with the same id, or appends it. */
export function savePlaylist(playlist: YoutubePlaylist): void {
  const current = readPlaylists();
  const exists = current.some((p) => p.id === playlist.id);
  writePlaylists(exists ? current.map((p) => (p.id === playlist.id ? playlist : p)) : [...current, playlist]);
}

export function removePlaylist(id: string): boolean {
  const current = readPlaylists();
  const next = current.filter((p) => p.id !== id);
  if (next.length === current.length) return false;
  writePlaylists(next);
  return true;
}
