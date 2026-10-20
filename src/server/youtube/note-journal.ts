import crypto from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import type { YoutubeNoteChange, YoutubeNoteChangeKind, YoutubeNoteChangeReason } from "../../shared/youtube.js";

export type { YoutubeNoteChange, YoutubeNoteChangeKind, YoutubeNoteChangeReason };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS youtube_note_changes (
    seq                INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id           TEXT NOT NULL,
    kind               TEXT NOT NULL,
    playlist_id        TEXT NOT NULL,
    note_path          TEXT,
    previous_note_path TEXT,
    title              TEXT NOT NULL,
    reason             TEXT,
    at                 TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_youtube_note_changes_video ON youtube_note_changes (video_id, seq);
`;

const JOURNAL_KEY = "notes_journal";
const GENERATION_BYTES = 8;
// <generation>.<sequence>: 16 hex characters, a dot, a decimal sequence number.
const CURSOR_RE = /^([0-9a-f]{16})\.(0|[1-9]\d{0,15})$/;

export type NoteCursorCode = "cursor_malformed" | "cursor_generation" | "cursor_ahead";

/** A cursor the feed refuses. The route turns `code` into a status; the client must not guess a new cursor. */
export class NoteCursorError extends Error {
  constructor(
    readonly code: NoteCursorCode,
    message: string,
  ) {
    super(message);
    this.name = "NoteCursorError";
  }
}

/** The event the journal stores. `note_path` and `previous_note_path` are relative to the notes folder. */
export interface NoteChangeRow {
  seq: number;
  video_id: string;
  kind: YoutubeNoteChangeKind;
  playlist_id: string;
  note_path: string | null;
  previous_note_path: string | null;
  title: string;
  reason: YoutubeNoteChangeReason | null;
  at: string;
}

export interface NoteChangesPage {
  generation: string;
  head: string;
  changes: YoutubeNoteChange[];
  nextCursor: string;
  hasMore: boolean;
}

interface NoteEvent {
  videoId: string;
  playlistId: string;
  title: string;
  notePath: string | null;
  previousNotePath?: string | null;
  reason?: YoutubeNoteChangeReason | null;
  now: string;
}

/** The note's path relative to the notes folder, with `/` separators, or null when it lies outside. */
export function relativeNotePath(root: string, file: string): string | null {
  if (!root) return null;
  const rel = path.relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** Why a row's export is blocked, from the reason the worker stored, or null when the row is not a blocked export. */
export function blockedNoteReason(status: string, reason: string | null): YoutubeNoteChangeReason | null {
  if (status !== "translating" || !reason || !/notes folder|note export/i.test(reason)) return null;
  if (/not mounted/i.test(reason)) return "notes_root_missing";
  if (/not writable/i.test(reason)) return "notes_root_unwritable";
  return "export_failed";
}

/**
 * The append-only journal of note changes that a mirror polls. Every row is
 * one event with a sequence number SQLite never reuses; a cursor names the
 * journal generation and the last sequence number the client has applied.
 * Nothing is ever pruned in this version, so any cursor the feed handed out
 * replays the same page.
 */
export class NoteJournal {
  private readonly generationId: string;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
    this.generationId = this.loadGeneration();
  }

  private loadGeneration(): string {
    const row = this.db.prepare("SELECT value FROM youtube_sync_state WHERE key = ?").get(JOURNAL_KEY) as
      | { value: string }
      | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as { generation?: unknown };
      if (typeof parsed.generation === "string" && /^[0-9a-f]{16}$/.test(parsed.generation)) return parsed.generation;
    }
    const generation = crypto.randomBytes(GENERATION_BYTES).toString("hex");
    this.db
      .prepare(
        "INSERT INTO youtube_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JOURNAL_KEY, JSON.stringify({ generation, createdAt: new Date().toISOString() }));
    return generation;
  }

  generation(): string {
    return this.generationId;
  }

  /** The sequence number of the newest event, or 0 when the journal is empty. */
  head(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM youtube_note_changes").get() as {
      head: number;
    };
    return row.head;
  }

  cursorOf(seq: number): string {
    return `${this.generationId}.${seq}`;
  }

  headCursor(): string {
    return this.cursorOf(this.head());
  }

  /** The sequence number a cursor stands for, or the start of the journal when none is given. */
  resolveCursor(cursor: string | undefined): number {
    if (cursor === undefined || cursor === "") return 0;
    const match = CURSOR_RE.exec(cursor);
    if (!match) throw new NoteCursorError("cursor_malformed", "Malformed cursor; use one the feed returned");
    if (match[1] !== this.generationId)
      throw new NoteCursorError("cursor_generation", "Cursor belongs to another journal generation; start again");
    const seq = Number(match[2]);
    if (seq > this.head())
      throw new NoteCursorError("cursor_ahead", "Cursor is ahead of the journal; the journal was reset or restored");
    return seq;
  }

  /**
   * The events after `afterSeq`, oldest first, snapshotted at the head read
   * in the same transaction: events appended while a client pages never make
   * a page skip one or report completion early.
   */
  page(afterSeq: number, limit: number): NoteChangesPage {
    return this.db.transaction((): NoteChangesPage => {
      const head = this.head();
      const rows = this.db
        .prepare("SELECT * FROM youtube_note_changes WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?")
        .all(afterSeq, head, limit + 1) as NoteChangeRow[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows.length ? pageRows[pageRows.length - 1].seq : afterSeq;
      return {
        generation: this.generationId,
        head: this.cursorOf(head),
        changes: pageRows.map((row) => this.toChange(row)),
        nextCursor: this.cursorOf(last),
        hasMore,
      };
    })();
  }

  private toChange(row: NoteChangeRow): YoutubeNoteChange {
    return {
      sequence: row.seq,
      cursor: this.cursorOf(row.seq),
      kind: row.kind,
      videoId: row.video_id,
      playlistId: row.playlist_id,
      notePath: row.note_path,
      previousNotePath: row.previous_note_path,
      title: row.title,
      reason: row.reason,
      at: row.at,
    };
  }

  /** The newest event of a video, if any. */
  latest(videoId: string): NoteChangeRow | undefined {
    return this.db
      .prepare("SELECT * FROM youtube_note_changes WHERE video_id = ? ORDER BY seq DESC LIMIT 1")
      .get(videoId) as NoteChangeRow | undefined;
  }

  private append(kind: YoutubeNoteChangeKind, event: NoteEvent): void {
    this.db
      .prepare(`
        INSERT INTO youtube_note_changes (video_id, kind, playlist_id, note_path, previous_note_path, title, reason, at)
        VALUES (@videoId, @kind, @playlistId, @notePath, @previousNotePath, @title, @reason, @now)
      `)
      .run({
        kind,
        videoId: event.videoId,
        playlistId: event.playlistId,
        notePath: event.notePath,
        previousNotePath: event.previousNotePath ?? null,
        title: event.title,
        reason: event.reason ?? null,
        now: event.now,
      });
  }

  /** The note was written (or written again, possibly under a new name). Every write is an event: the body may differ. */
  noteWritten(event: NoteEvent & { notePath: string }): void {
    this.append("upsert", { ...event, reason: null });
  }

  /** The note cannot be served or written for `reason`. Repeating the same reason adds nothing. */
  noteUnavailable(event: NoteEvent & { reason: YoutubeNoteChangeReason }): boolean {
    const latest = this.latest(event.videoId);
    if (latest?.kind === "unavailable" && latest.reason === event.reason) return false;
    this.append("unavailable", event);
    return true;
  }

  /** The note is gone and SubSmelt does not expect it back. Repeating adds nothing. */
  noteRemoved(event: NoteEvent): boolean {
    const latest = this.latest(event.videoId);
    if (latest?.kind === "remove") return false;
    this.append("remove", { ...event, reason: null });
    return true;
  }

  /** Another playlist took the video over: its newest event is repeated under the new owner. */
  ownerChanged(videoId: string, playlistId: string, now: string): boolean {
    const latest = this.latest(videoId);
    if (!latest || latest.playlist_id === playlistId) return false;
    this.append(latest.kind, {
      videoId,
      playlistId,
      title: latest.title,
      notePath: latest.note_path,
      reason: latest.reason,
      now,
    });
    return true;
  }

  /**
   * Gives every note written before the journal existed, and every export the
   * notes folder blocks, a first event, so a mirror can start from an empty
   * cursor. Rows that already have an event are left alone, so running it at
   * every start costs one indexed query and changes nothing after the first.
   */
  seed(root: string, now: string): number {
    const rows = this.db
      .prepare(`
        SELECT v.video_id, v.playlist_id, v.title, v.note_path, v.status, v.reason FROM youtube_videos v
        WHERE (v.note_path IS NOT NULL OR (v.status = 'translating' AND v.reason IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM youtube_note_changes c WHERE c.video_id = v.video_id)
        ORDER BY v.video_id
      `)
      .all() as {
      video_id: string;
      playlist_id: string;
      title: string;
      note_path: string | null;
      status: string;
      reason: string | null;
    }[];
    return this.db.transaction((): number => {
      let seeded = 0;
      for (const row of rows) {
        const base = { videoId: row.video_id, playlistId: row.playlist_id, title: row.title, now };
        if (row.note_path) {
          const notePath = relativeNotePath(root, row.note_path);
          if (notePath) this.noteWritten({ ...base, notePath });
          else this.noteUnavailable({ ...base, notePath: null, reason: "note_unreadable" });
          seeded += 1;
          continue;
        }
        const reason = blockedNoteReason(row.status, row.reason);
        if (!reason) continue;
        this.noteUnavailable({ ...base, notePath: null, reason });
        seeded += 1;
      }
      return seeded;
    })();
  }
}
