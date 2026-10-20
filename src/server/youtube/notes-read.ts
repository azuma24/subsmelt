import fs from "node:fs";
import path from "node:path";
import type { YoutubeNote, YoutubeNotesList, YoutubeNotesState } from "../../shared/youtube.js";
import { getSetting } from "../config.js";
import { notesFolderStatus } from "./note-export.js";
import { blockedNoteReason, type YoutubeNoteChangeReason } from "./note-journal.js";
import type { YoutubePlaylist } from "./playlists.js";
import type { VideoRow, YoutubeStore } from "./store.js";

const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_QUERY_LENGTH = 200;
const MAX_LIMIT = 100;

const BLOCKED_LABELS: Record<YoutubeNoteChangeReason, string> = {
  notes_root_missing: "Notes folder is not mounted",
  notes_root_unwritable: "Notes folder is not writable",
  export_failed: "Note export failed",
  note_missing: "Saved note is missing or unreadable",
  note_unreadable: "Saved note is missing or unreadable",
};

export interface NotesQuery {
  query: string;
  playlistId: string | null;
  state: YoutubeNotesState;
  limit: number;
  offset: number;
}

export function parseNotesQuery(input: Record<string, unknown>, playlistIds: ReadonlySet<string>): NotesQuery | string {
  if (Object.keys(input).some((key) => !["query", "playlistId", "state", "limit", "offset"].includes(key)))
    return "Invalid notes filter";
  const string = (value: unknown) => value === undefined || typeof value === "string";
  if (![input.query, input.playlistId, input.state, input.limit, input.offset].every(string))
    return "Invalid notes filter";
  const query = (input.query as string | undefined)?.trim() ?? "";
  if (query.length > MAX_QUERY_LENGTH) return "Query is too long";
  const playlistId = (input.playlistId as string | undefined) || null;
  if (playlistId && !playlistIds.has(playlistId)) return "Playlist is not followed";
  const state = (input.state ?? "all") as string;
  if (!(["all", "saved", "blocked"] as string[]).includes(state)) return "Invalid notes state";
  const number = (raw: unknown, fallback: number, max: number) => {
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
  };
  const limit = number(input.limit, 25, MAX_LIMIT);
  const offset = number(input.offset, 0, 1_000_000);
  if (limit === null || limit < 1 || offset === null) return "Invalid notes pagination";
  return { query, playlistId, state: state as YoutubeNotesState, limit, offset };
}

/** Resolve only a DB-owned note under the configured root; never follow a path outside it. */
function safeNoteFile(root: string, saved: string): { file: string; relative: string; mtime: string } | null {
  try {
    const canonicalRoot = fs.realpathSync(root);
    const canonicalFile = fs.realpathSync(saved);
    const relative = path.relative(canonicalRoot, canonicalFile);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return null;
    if (path.extname(canonicalFile).toLowerCase() !== ".md") return null;
    const stat = fs.statSync(canonicalFile);
    if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) return null;
    return { file: canonicalFile, relative: relative.split(path.sep).join("/"), mtime: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function readContent(file: string): string | null {
  try {
    // Never follow a swapped final symlink after path validation; cap the read even if the file grows.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) return null;
      const bytes = Buffer.alloc(stat.size);
      let used = 0;
      while (used < bytes.length) {
        const n = fs.readSync(fd, bytes, used, bytes.length - used, used);
        if (!n) break;
        used += n;
      }
      return bytes.subarray(0, used).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function noteOf(
  row: VideoRow,
  playlist: YoutubePlaylist,
  root: string,
  readBody = false,
): { note: YoutubeNote; content: string | null } | null {
  const safe = row.note_path ? safeNoteFile(root, row.note_path) : null;
  const content = safe && readBody ? readContent(safe.file) : null;
  if (safe && (!readBody || content !== null)) {
    return {
      note: {
        videoId: row.video_id,
        title: row.title,
        channel: row.channel,
        playlistId: playlist.id,
        playlistTitle: playlist.title,
        publishedAt: row.published_at,
        notePath: safe.relative,
        exportedAt: safe.mtime,
        status: "saved",
        reason: null,
      },
      content,
    };
  }
  // A missing/unsafe path must not disappear silently from export health.
  const blocked = row.note_path ? "note_unreadable" : blockedNoteReason(row.status, row.reason);
  if (!blocked) return null;
  const reason = BLOCKED_LABELS[blocked];
  return {
    note: {
      videoId: row.video_id,
      title: row.title,
      channel: row.channel,
      playlistId: playlist.id,
      playlistTitle: playlist.title,
      publishedAt: row.published_at,
      notePath: null,
      exportedAt: null,
      status: "blocked",
      reason,
    },
    content: null,
  };
}

export function listNotes(
  store: YoutubeStore,
  playlists: readonly YoutubePlaylist[],
  options: NotesQuery,
): YoutubeNotesList {
  const root = getSetting("youtube_notes_dir");
  const folder = notesFolderStatus(root);
  const owners = new Map(playlists.map((p) => [p.id, p]));
  const ids = options.playlistId ? [options.playlistId] : [...owners.keys()];
  const query = options.query.toLocaleLowerCase();
  const matches: YoutubeNote[] = [];
  const countsByPlaylist: YoutubeNotesList["countsByPlaylist"] = {};
  for (const row of store.noteCandidates(ids)) {
    const playlist = owners.get(row.playlist_id);
    if (!playlist) continue;
    const item = noteOf(row, playlist, root, Boolean(query));
    if (!item) continue;
    if (!countsByPlaylist[playlist.id]) countsByPlaylist[playlist.id] = { saved: 0, blocked: 0 };
    countsByPlaylist[playlist.id][item.note.status] += 1;
    if (options.state !== "all" && item.note.status !== options.state) continue;
    if (
      query &&
      ![item.note.title, item.note.channel, item.note.playlistTitle, item.content].some((text) =>
        text?.toLocaleLowerCase().includes(query),
      )
    )
      continue;
    matches.push(item.note);
  }
  return {
    notes: matches.slice(options.offset, options.offset + options.limit),
    total: matches.length,
    health: { path: folder.path, exists: folder.exists, writable: folder.writable, blocked: !folder.writable },
    countsByPlaylist,
  };
}

export function getNote(
  store: YoutubeStore,
  playlists: readonly YoutubePlaylist[],
  videoId: string,
): { note: YoutubeNote; content: string } | null {
  const row = store.getVideo(videoId);
  const playlist = row && playlists.find((p) => p.id === row.playlist_id);
  if (!row || !playlist) return null;
  const result = noteOf(row, playlist, getSetting("youtube_notes_dir"), true);
  return result?.note.status === "saved" && result.content !== null
    ? { note: result.note, content: result.content }
    : null;
}
