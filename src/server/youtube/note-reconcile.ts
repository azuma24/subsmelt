import fs from "node:fs";
import { notesFolderStatus } from "./note-export.js";
import { relativeNotePath, type NoteChangeRow } from "./note-journal.js";
import type { VideoRow, YoutubeStore } from "./store.js";

// A note missing this long under a healthy notes folder is reported removed rather than unavailable.
export const NOTE_REMOVE_AFTER_MS = 24 * 60 * 60_000;

export interface ReconcileOptions {
  root: string;
  now: string;
  /** The video id the previous batch ended on; null starts over. */
  after: string | null;
  limit: number;
}

export interface ReconcileResult {
  /** Why nothing was checked, or null when the batch ran. */
  skipped: "root_missing" | "root_empty" | null;
  checked: number;
  events: number;
  /** Where the next batch starts; null once the walk has wrapped. */
  next: string | null;
}

type Presence = "present" | "missing" | "unreadable";

function presenceOf(file: string): Presence {
  try {
    return fs.statSync(file).isFile() ? "present" : "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

function hasEntries(dir: string): boolean {
  try {
    const handle = fs.opendirSync(dir);
    try {
      return handle.readSync() !== null;
    } finally {
      handle.closeSync();
    }
  } catch {
    return false;
  }
}

/** Journals what the notes folder says about one saved note, against the video's newest event. */
function reconcileNote(store: YoutubeStore, row: VideoRow, root: string, now: string): boolean {
  const { journal } = store;
  const latest: NoteChangeRow | undefined = journal.latest(row.video_id);
  const event = { videoId: row.video_id, playlistId: row.playlist_id, title: row.title, now };
  const notePath = relativeNotePath(root, row.note_path!);
  if (!notePath) return journal.noteUnavailable({ ...event, notePath: null, reason: "note_unreadable" });
  const presence = presenceOf(row.note_path!);
  if (presence === "present") {
    if (latest?.kind === "upsert" && latest.note_path === notePath) return false;
    const previous = latest?.note_path && latest.note_path !== notePath ? latest.note_path : null;
    journal.noteWritten({ ...event, notePath, previousNotePath: previous });
    return true;
  }
  if (presence === "unreadable") return journal.noteUnavailable({ ...event, notePath, reason: "note_unreadable" });
  // Already retired: nothing new to say until the file is back.
  if (latest?.kind === "remove") return false;
  const missingSince =
    latest?.kind === "unavailable" && latest.reason === "note_missing" ? Date.parse(latest.at) : null;
  if (missingSince !== null && Date.parse(now) - missingSince >= NOTE_REMOVE_AFTER_MS)
    return journal.noteRemoved({ ...event, notePath });
  return journal.noteUnavailable({ ...event, notePath, reason: "note_missing" });
}

/**
 * Checks one batch of saved notes against the notes folder and journals what
 * changed outside SubSmelt: a note deleted by hand becomes unavailable, then
 * removed once it has stayed missing for a day; a note that is back becomes
 * an upsert again. A note whose body was edited in place is not detected.
 * While the folder is missing or empty nothing is checked, so an unmounted
 * folder never reads as every note deleted.
 */
export function reconcileSavedNotes(store: YoutubeStore, options: ReconcileOptions): ReconcileResult {
  const { root, now, after, limit } = options;
  if (!notesFolderStatus(root).exists) return { skipped: "root_missing", checked: 0, events: 0, next: after };
  if (!hasEntries(root)) return { skipped: "root_empty", checked: 0, events: 0, next: after };
  const rows = store.savedNotes(after, limit);
  let events = 0;
  for (const row of rows) if (reconcileNote(store, row, root, now)) events += 1;
  const next = rows.length === limit ? rows[rows.length - 1].video_id : null;
  return { skipped: null, checked: rows.length, events, next };
}
