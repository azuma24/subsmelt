import crypto from "node:crypto";
import type { YoutubeNoteChanges, YoutubeNotesSyncState } from "../../shared/youtube.js";
import { notesFolderStatus } from "./note-export.js";
import { noteFolderSegments } from "./note.js";
import type { YoutubePlaylist } from "./playlists.js";
import type { YoutubeStore } from "./store.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 100;

export interface ChangesQuery {
  after: string | undefined;
  limit: number;
}

/** The query of GET /api/youtube/notes/changes, or the message a 400 carries. */
export function parseChangesQuery(input: Record<string, unknown>): ChangesQuery | string {
  if (Object.keys(input).some((key) => !["after", "limit"].includes(key))) return "Invalid changes filter";
  if (input.after !== undefined && typeof input.after !== "string") return "Invalid cursor";
  if (input.limit === undefined) return { after: input.after as string | undefined, limit: DEFAULT_LIMIT };
  if (typeof input.limit !== "string" || !/^[1-9]\d{0,2}$/.test(input.limit) || Number(input.limit) > MAX_LIMIT)
    return `limit must be a whole number from 1 to ${MAX_LIMIT}`;
  return { after: input.after as string | undefined, limit: Number(input.limit) };
}

/** One page of the change journal. Throws NoteCursorError for a cursor the feed refuses. */
export function notesChanges(store: YoutubeStore, query: ChangesQuery): YoutubeNoteChanges {
  return store.journal.page(store.journal.resolveCursor(query.after), query.limit);
}

/**
 * What a mirror needs between polls of the feed: which playlists are ticked
 * for the knowledge base (by id, with the relative folder their notes go
 * into), a revision that moves whenever that list does, where the journal
 * stands, and whether the notes folder is there. No host path is included.
 */
export function notesSyncState(
  store: YoutubeStore,
  playlists: readonly YoutubePlaylist[],
  root: string,
): YoutubeNotesSyncState {
  const selection = playlists
    .filter((p) => p.secondBrainExport)
    .map((p) => ({ playlistId: p.id, title: p.title, folder: noteFolderSegments(p.folder).join("/") }))
    .sort((a, b) => a.playlistId.localeCompare(b.playlistId));
  const folder = notesFolderStatus(root);
  return {
    generation: store.journal.generation(),
    head: store.journal.headCursor(),
    selectionRevision: crypto.createHash("sha256").update(JSON.stringify(selection)).digest("hex").slice(0, 16),
    selection,
    notesRoot: { exists: folder.exists, writable: folder.writable },
  };
}
