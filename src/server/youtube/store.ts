import type Database from "better-sqlite3";
import { canTransition, type SkipKind, type VideoStatus } from "./video-status.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS youtube_videos (
    video_id      TEXT PRIMARY KEY,
    playlist_id   TEXT NOT NULL,
    title         TEXT NOT NULL,
    channel       TEXT,
    duration_s    INTEGER,
    published_at  TEXT,
    added_at      TEXT,
    status        TEXT NOT NULL,
    skip_kind     TEXT,
    reason        TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    retry_after   TEXT,
    media_path    TEXT,
    subtitle_path TEXT,
    note_path     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_youtube_videos_playlist ON youtube_videos (playlist_id, status);
  CREATE TABLE IF NOT EXISTS youtube_playlist_items (
    playlist_id   TEXT NOT NULL,
    video_id      TEXT NOT NULL REFERENCES youtube_videos(video_id),
    position      INTEGER,
    first_seen_at TEXT NOT NULL,
    removed_at    TEXT,
    PRIMARY KEY (playlist_id, video_id)
  );
  CREATE TABLE IF NOT EXISTS youtube_sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** One entry of a flat playlist listing. Missing fields stay null. */
export interface ListingEntry {
  videoId: string;
  title: string | null;
  channel: string | null;
  durationS: number | null;
  /** YYYY-MM-DD. Approximate from a flat listing, exact once looked up. */
  publishedAt: string | null;
  position: number;
}

export interface InitialState {
  status: VideoStatus;
  skipKind?: SkipKind | null;
  reason?: string | null;
}

/** A listing entry plus what a first sighting of it should store. */
export interface ListedVideo extends ListingEntry {
  initial: InitialState;
  addedAt?: string | null;
}

export interface VideoRow {
  video_id: string;
  playlist_id: string;
  title: string;
  channel: string | null;
  duration_s: number | null;
  published_at: string | null;
  added_at: string | null;
  status: VideoStatus;
  skip_kind: SkipKind | null;
  reason: string | null;
  attempts: number;
  retry_after: string | null;
  media_path: string | null;
  subtitle_path: string | null;
  note_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlaylistVideoRow extends VideoRow {
  position: number | null;
  first_seen_at: string;
  removed_at: string | null;
}

export interface PlaylistSyncState {
  lastCheckedAt: string | null;
  lastError: string | null;
  /** YouTube's reported playlist_count at the last successful listing. */
  count: number | null;
  /** "public", "unlisted" or "private" as yt-dlp reports it. */
  availability: string | null;
  /** When the first listing was stored. Entries first seen then are the backfill set. */
  firstSyncAt: string | null;
}

export interface ApplyListingResult {
  added: number;
  removed: number;
  restored: number;
}

export interface PlaylistCounts {
  total: number;
  removed: number;
  byStatus: Partial<Record<VideoStatus, number>>;
}

export class IllegalTransitionError extends Error {
  constructor(videoId: string, from: VideoStatus, to: VideoStatus) {
    super(`Video ${videoId} cannot move from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
  }
}

const EMPTY_SYNC_STATE: PlaylistSyncState = { lastCheckedAt: null, lastError: null, count: null, availability: null, firstSyncAt: null };

const syncKey = (playlistId: string) => `playlist:${playlistId}`;

export class YoutubeStore {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  /**
   * Upserts every listed video and its membership in one transaction. A first
   * sighting stores `initial`; a known video only refreshes metadata, so a
   * skipped tombstone stays skipped. `resetUntouched` (a first sync after a
   * re-follow) also re-applies `initial` to this playlist's videos that are
   * still waiting or were left out by a filter. Missing members are marked removed only
   * when `complete` says the listing covers the whole playlist.
   */
  applyListing(playlistId: string, videos: ListedVideo[], opts: { complete: boolean; now: string; resetUntouched?: boolean }): ApplyListingResult {
    const insertVideo = this.db.prepare(`
      INSERT INTO youtube_videos (video_id, playlist_id, title, channel, duration_s, published_at, added_at, status, skip_kind, reason, created_at, updated_at)
      VALUES (@videoId, @playlistId, @title, @channel, @durationS, @publishedAt, @addedAt, @status, @skipKind, @reason, @now, @now)
      ON CONFLICT(video_id) DO UPDATE SET
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE youtube_videos.title END,
        channel = COALESCE(excluded.channel, youtube_videos.channel),
        duration_s = COALESCE(excluded.duration_s, youtube_videos.duration_s),
        published_at = COALESCE(youtube_videos.published_at, excluded.published_at),
        added_at = COALESCE(excluded.added_at, youtube_videos.added_at),
        status = CASE WHEN @resetUntouched = 1 AND youtube_videos.playlist_id = excluded.playlist_id
            AND (youtube_videos.status IN ('new', 'queued') OR (youtube_videos.status = 'skipped' AND youtube_videos.skip_kind = 'before_start'))
          THEN excluded.status ELSE youtube_videos.status END,
        skip_kind = CASE WHEN @resetUntouched = 1 AND youtube_videos.playlist_id = excluded.playlist_id
            AND (youtube_videos.status IN ('new', 'queued') OR (youtube_videos.status = 'skipped' AND youtube_videos.skip_kind = 'before_start'))
          THEN excluded.skip_kind ELSE youtube_videos.skip_kind END,
        updated_at = @now
    `);
    const existingItem = this.db.prepare(
      "SELECT removed_at FROM youtube_playlist_items WHERE playlist_id = ? AND video_id = ?",
    );
    const upsertItem = this.db.prepare(`
      INSERT INTO youtube_playlist_items (playlist_id, video_id, position, first_seen_at, removed_at)
      VALUES (@playlistId, @videoId, @position, @now, NULL)
      ON CONFLICT(playlist_id, video_id) DO UPDATE SET position = excluded.position, removed_at = NULL
    `);
    const markRemoved = this.db.prepare(`
      UPDATE youtube_playlist_items SET removed_at = @now
      WHERE playlist_id = @playlistId AND removed_at IS NULL
        AND video_id NOT IN (SELECT value FROM json_each(@listed))
    `);

    return this.db.transaction((): ApplyListingResult => {
      let added = 0;
      let restored = 0;
      for (const video of videos) {
        const item = existingItem.get(playlistId, video.videoId) as { removed_at: string | null } | undefined;
        if (!item) added += 1;
        else if (item.removed_at) restored += 1;
        insertVideo.run({
          videoId: video.videoId,
          playlistId,
          title: video.title ?? "",
          channel: video.channel,
          durationS: video.durationS,
          publishedAt: video.publishedAt,
          addedAt: video.addedAt ?? null,
          status: video.initial.status,
          skipKind: video.initial.skipKind ?? null,
          reason: video.initial.reason ?? null,
          now: opts.now,
          resetUntouched: opts.resetUntouched ? 1 : 0,
        });
        upsertItem.run({ playlistId, videoId: video.videoId, position: video.position, now: opts.now });
      }
      const removed = opts.complete
        ? markRemoved.run({ playlistId, now: opts.now, listed: JSON.stringify(videos.map((v) => v.videoId)) }).changes
        : 0;
      return { added, removed, restored };
    })();
  }

  /** Ids from `videoIds` that already have a membership row in the playlist. */
  knownMembers(playlistId: string, videoIds: string[]): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT video_id FROM youtube_playlist_items WHERE playlist_id = ? AND video_id IN (SELECT value FROM json_each(?))",
      )
      .all(playlistId, JSON.stringify(videoIds)) as { video_id: string }[];
    return new Set(rows.map((r) => r.video_id));
  }

  getVideo(videoId: string): VideoRow | undefined {
    return this.db.prepare("SELECT * FROM youtube_videos WHERE video_id = ?").get(videoId) as VideoRow | undefined;
  }

  /** Moves a video to `to`, refusing any move the status table does not allow. */
  setStatus(videoId: string, to: VideoStatus, fields: { skipKind?: SkipKind | null; reason?: string | null; now: string }): VideoRow {
    const current = this.getVideo(videoId);
    if (!current) throw new Error(`Unknown video ${videoId}`);
    if (!canTransition(current.status, to)) throw new IllegalTransitionError(videoId, current.status, to);
    this.db
      .prepare("UPDATE youtube_videos SET status = ?, skip_kind = ?, reason = ?, updated_at = ? WHERE video_id = ?")
      .run(to, to === "skipped" ? fields.skipKind ?? "user" : null, fields.reason ?? null, fields.now, videoId);
    return this.getVideo(videoId)!;
  }

  /** Videos in playlist order, removed members included. */
  playlistVideos(playlistId: string): PlaylistVideoRow[] {
    return this.db
      .prepare(`
        SELECT v.*, i.position, i.first_seen_at, i.removed_at
        FROM youtube_playlist_items i JOIN youtube_videos v ON v.video_id = i.video_id
        WHERE i.playlist_id = ?
        ORDER BY i.removed_at IS NOT NULL, i.position, v.created_at
      `)
      .all(playlistId) as PlaylistVideoRow[];
  }

  counts(playlistId: string): PlaylistCounts {
    const rows = this.db
      .prepare(`
        SELECT v.status AS status, i.removed_at IS NOT NULL AS removed, COUNT(*) AS n
        FROM youtube_playlist_items i JOIN youtube_videos v ON v.video_id = i.video_id
        WHERE i.playlist_id = ?
        GROUP BY v.status, removed
      `)
      .all(playlistId) as { status: VideoStatus; removed: number; n: number }[];
    const result: PlaylistCounts = { total: 0, removed: 0, byStatus: {} };
    for (const row of rows) {
      if (row.removed) {
        result.removed += row.n;
        continue;
      }
      result.total += row.n;
      result.byStatus[row.status] = (result.byStatus[row.status] ?? 0) + row.n;
    }
    return result;
  }

  getSyncState(playlistId: string): PlaylistSyncState {
    const row = this.db.prepare("SELECT value FROM youtube_sync_state WHERE key = ?").get(syncKey(playlistId)) as
      | { value: string }
      | undefined;
    return row ? { ...EMPTY_SYNC_STATE, ...(JSON.parse(row.value) as Partial<PlaylistSyncState>) } : { ...EMPTY_SYNC_STATE };
  }

  updateSyncState(playlistId: string, patch: Partial<PlaylistSyncState>): PlaylistSyncState {
    const next = { ...this.getSyncState(playlistId), ...patch };
    this.db
      .prepare("INSERT INTO youtube_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(syncKey(playlistId), JSON.stringify(next));
    return next;
  }

  deleteSyncState(playlistId: string): void {
    this.db.prepare("DELETE FROM youtube_sync_state WHERE key = ?").run(syncKey(playlistId));
  }
}
