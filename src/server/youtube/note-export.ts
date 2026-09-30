import fs from "node:fs";
import path from "node:path";
import { parseSync } from "subtitle";
import { getSetting, getTask } from "../config.js";
import { logger } from "../logger.js";
import { notify } from "../notify.js";
import { MEDIA_DIR } from "../scanner.js";
import { broadcast } from "../sse.js";
import { readSubtitleFileText } from "../translator/encoding.js";
import { noteFileName, renderNote, safeNoteName, type Chapter, type Cue, type NoteInfo, type NoteTranslation } from "./note.js";
import { findPlaylist, type YoutubePlaylist } from "./playlists.js";
import type { VideoRow, YoutubeStore } from "./store.js";

export interface NotesFolderStatus {
  path: string;
  exists: boolean;
  writable: boolean;
}

/** Whether the notes folder is there and SubSmelt may write into it. It is never created: a missing mount must show. */
export function notesFolderStatus(dir: string = getSetting("youtube_notes_dir")): NotesFolderStatus {
  try {
    if (!fs.statSync(dir).isDirectory()) return { path: dir, exists: false, writable: false };
  } catch {
    return { path: dir, exists: false, writable: false };
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return { path: dir, exists: true, writable: true };
  } catch {
    return { path: dir, exists: true, writable: false };
  }
}

export type NoteExportFailure = "unknown_video" | "no_media" | "no_transcript" | "notes_folder";

export class NoteExportError extends Error {
  constructor(readonly kind: NoteExportFailure, message: string) {
    super(message);
    this.name = "NoteExportError";
  }
}

/** The `youtube:note` SSE event and webhook payload. `notePath` is relative to the notes folder. */
export interface NoteReadyPayload {
  videoId: string;
  title: string;
  channel: string | null;
  url: string;
  playlistId: string;
  notePath: string;
  translations: string[];
}

export interface NoteExportDeps {
  store: YoutubeStore;
  /** SSE broadcast; the webhook always goes through notify(). */
  announce?: (event: string, data: Record<string, unknown>) => void;
}

type Info = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function readInfo(file: string): Info {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Info) : {};
  } catch {
    return {};
  }
}

function readCues(file: string): Cue[] {
  return parseSync(readSubtitleFileText(file))
    .filter((node) => node.type === "cue")
    .map((node) => {
      const data = node.data as { start: number; end: number; text: string };
      return { start: data.start / 1000, end: data.end / 1000, text: data.text };
    });
}

function chaptersOf(info: Info): Chapter[] {
  if (!Array.isArray(info.chapters)) return [];
  return info.chapters.flatMap((c: Info) =>
    typeof c?.start_time === "number" && str(c.title) ? [{ start: c.start_time, title: str(c.title)! }] : [],
  );
}

const sameLanguage = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(`${b.toLowerCase()}-`);

/** `<base>.<lang>.srt` files next to the media, by language suffix. */
function subtitlesBesideMedia(dir: string, base: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${base}.`) || !name.toLowerCase().endsWith(".srt")) continue;
    const suffix = name.slice(base.length + 1, -".srt".length);
    if (suffix && !suffix.includes(".")) found.set(suffix, path.join(dir, name));
  }
  return found;
}

function taskOutputPath(dir: string, base: string, task: { output_pattern: string; lang_code: string }): string {
  const name = task.output_pattern.replace(/\{\{name\}\}/g, base).replace(/\{\{lang_code\}\}/g, task.lang_code).replace(/\{\{ext\}\}/g, "srt");
  return path.join(dir, name);
}

function resolveMediaRelative(p: string): string {
  return path.isAbsolute(p) ? p : path.join(MEDIA_DIR, p);
}

interface Transcript {
  file: string;
  /** The language suffix of the file name, when it has one. */
  suffix: string | null;
}

/**
 * The spoken-language subtitle: the one the video row records, else the file
 * in the info JSON's language, else any `<base>.<lang>.srt` no task wrote.
 */
function findTranscript(video: VideoRow, besides: Map<string, string>, language: string | null, taskOutputs: Set<string>): Transcript | null {
  if (video.subtitle_path) {
    const file = resolveMediaRelative(video.subtitle_path);
    if (fs.existsSync(file)) return { file, suffix: [...besides].find(([, f]) => f === file)?.[0] ?? null };
  }
  const entries = [...besides].sort(([a], [b]) => a.localeCompare(b));
  const inLanguage = language ? entries.find(([suffix]) => sameLanguage(suffix, language)) : undefined;
  const pick = inLanguage ?? entries.find(([, file]) => !taskOutputs.has(file));
  return pick ? { file: pick[1], suffix: pick[0] } : null;
}

function translationsFor(
  playlist: YoutubePlaylist | undefined,
  dir: string,
  base: string,
  transcript: Transcript,
  sourceCues: Cue[],
): NoteTranslation[] {
  const sourceTexts = sourceCues.map((c) => c.text).join("\n");
  const out: NoteTranslation[] = [];
  for (const id of playlist?.subtitleTaskIds ?? []) {
    const task = getTask(id);
    if (!task) continue;
    const file = taskOutputPath(dir, base, task);
    if (file === transcript.file || !fs.existsSync(file)) continue;
    const cues = readCues(file);
    // A task in the spoken language copies the transcript; it needs no second section.
    if (cues.map((c) => c.text).join("\n") === sourceTexts) continue;
    out.push({ label: task.target_lang, langCode: task.lang_code, cues });
  }
  return out;
}

function transcriptSource(info: Info, playlist: YoutubePlaylist | undefined, language: string | null): string {
  const creator = info.subtitles && typeof info.subtitles === "object" ? Object.keys(info.subtitles) : [];
  const fromYoutube = playlist?.captions !== "whisper_only" && language !== null && creator.some((code) => sameLanguage(code, language));
  return fromYoutube ? "youtube_captions" : `whisper:${getSetting("transcription_model")}`;
}

function uploadDate(info: Info): string | null {
  const raw = str(info.upload_date);
  return raw && /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
}

/** Writes beside the target and renames over it, so Obsidian never reads half a note. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Renders and writes the note of one downloaded video from its info JSON and
 * the subtitle files beside its media, then announces it over SSE and the
 * webhook. Running it again overwrites the note; a note left under an old
 * title is removed.
 */
export async function exportNoteForVideo(deps: NoteExportDeps, videoId: string): Promise<NoteReadyPayload & { file: string }> {
  const video = deps.store.getVideo(videoId);
  if (!video) throw new NoteExportError("unknown_video", `Unknown video ${videoId}`);
  if (!video.media_path) throw new NoteExportError("no_media", `Video ${videoId} has not been downloaded`);

  const media = resolveMediaRelative(video.media_path);
  const dir = path.dirname(media);
  const base = path.basename(media, path.extname(media));
  const info = readInfo(path.join(dir, `${base}.info.json`));
  const playlist = findPlaylist(video.playlist_id);

  let besides: Map<string, string>;
  try {
    besides = subtitlesBesideMedia(dir, base);
  } catch {
    throw new NoteExportError("no_media", `The folder of ${video.media_path} is missing`);
  }
  const tasks = (playlist?.subtitleTaskIds ?? []).map(getTask).filter((t) => t !== undefined);
  const taskOutputs = new Set(tasks.map((task) => taskOutputPath(dir, base, task)));
  const transcript = findTranscript(video, besides, str(info.language), taskOutputs);
  if (!transcript) throw new NoteExportError("no_transcript", `No subtitle found beside ${video.media_path}`);

  const root = getSetting("youtube_notes_dir");
  const status = notesFolderStatus(root);
  if (!status.writable) {
    throw new NoteExportError("notes_folder", status.exists ? `Notes folder ${root} is not writable` : `Notes folder ${root} is not mounted`);
  }

  const cues = readCues(transcript.file);
  const language = str(info.language) ?? transcript.suffix;
  const translations = translationsFor(playlist, dir, base, transcript, cues);
  const title = str(info.title) ?? video.title;
  const channel = str(info.channel) ?? str(info.uploader) ?? video.channel;
  const noteInfo: NoteInfo = {
    videoId,
    title,
    channel,
    published: uploadDate(info) ?? video.published_at,
    added: video.added_at?.slice(0, 10) ?? null,
    durationS: typeof info.duration === "number" ? Math.round(info.duration) : video.duration_s,
    playlist: playlist?.title ?? null,
    language,
    transcriptSource: transcriptSource(info, playlist, language),
    description: str(info.description),
    chapters: chaptersOf(info),
  };

  const folder = (playlist?.folder ?? path.basename(dir)).split("/").map(safeNoteName).filter(Boolean);
  const noteDir = path.join(root, ...folder);
  fs.mkdirSync(noteDir, { recursive: true });
  const file = path.join(noteDir, noteFileName(title, videoId));
  writeFileAtomic(file, renderNote(noteInfo, cues, translations));
  if (video.note_path && video.note_path !== file && isInside(root, video.note_path)) fs.rmSync(video.note_path, { force: true });
  deps.store.setNotePath(videoId, file, new Date().toISOString());

  const payload: NoteReadyPayload = {
    videoId,
    title,
    channel,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    playlistId: video.playlist_id,
    notePath: path.relative(root, file).split(path.sep).join("/"),
    translations: translations.map((t) => t.langCode),
  };
  logger.info("youtube", `Wrote note ${payload.notePath}`);
  (deps.announce ?? broadcast)("youtube:note", { ...payload });
  await notify("youtube:note", { ...payload });
  return { ...payload, file };
}
