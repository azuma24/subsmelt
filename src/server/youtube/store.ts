import type Database from "better-sqlite3";
import { canTransition, USER_ACTIONS, type SkipKind, type UserAction, type VideoStatus } from "./video-status.js";

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
    user_queued_at TEXT,
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
  /** Set when the user asked for this video: it goes first and a filter change leaves it alone. */
  user_queued_at: string | null;
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

export type CooldownCause = "rate_limited" | "bot_check";

export interface Cooldown {
  until: string;
  cause: CooldownCause;
  /** Cooldowns since the last successful download; each one doubles the pause. */
  strikes: number;
}

const COOLDOWN_BASE_MS = 60 * 60_000;
const COOLDOWN_MAX_MS = 24 * 60 * 60_000;
const COOLDOWN_KEY = "cooldown";

/** Columns a status move may also set. Unset reason and retryAfter clear; the rest keep their value. */
export interface StatusFields {
  now: string;
  skipKind?: SkipKind | null;
  reason?: string | null;
  retryAfter?: string | null;
  attempts?: number;
  mediaPath?: string | null;
  userQueuedAt?: string | null;
}

export interface VideoMetadata {
  title?: string | null;
  channel?: string | null;
  durationS?: number | null;
  publishedAt?: string | null;
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
    const columns = db.prepare("PRAGMA table_info(youtube_videos)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "user_queued_at")) db.exec("ALTER TABLE youtube_videos ADD COLUMN user_queued_at TEXT");
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
            AND youtube_videos.user_queued_at IS NULL
            AND (youtube_videos.status IN ('new', 'queued') OR (youtube_videos.status = 'skipped' AND youtube_videos.skip_kind = 'before_start'))
          THEN excluded.status ELSE youtube_videos.status END,
        skip_kind = CASE WHEN @resetUntouched = 1 AND youtube_videos.playlist_id = excluded.playlist_id
            AND youtube_videos.user_queued_at IS NULL
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
  setStatus(videoId: string, to: VideoStatus, fields: StatusFields): VideoRow {
    const current = this.getVideo(videoId);
    if (!current) throw new Error(`Unknown video ${videoId}`);
    if (!canTransition(current.status, to)) throw new IllegalTransitionError(videoId, current.status, to);
    this.db
      .prepare(`
        UPDATE youtube_videos SET status = @to, skip_kind = @skipKind, reason = @reason, retry_after = @retryAfter,
          attempts = @attempts, media_path = @mediaPath, user_queued_at = @userQueuedAt, updated_at = @now
        WHERE video_id = @videoId
      `)
      .run({
        videoId,
        to,
        skipKind: to === "skipped" ? fields.skipKind ?? "user" : null,
        reason: fields.reason ?? null,
        retryAfter: fields.retryAfter ?? null,
        attempts: fields.attempts ?? current.attempts,
        mediaPath: fields.mediaPath === undefined ? current.media_path : fields.mediaPath,
        userQueuedAt: fields.userQueuedAt === undefined ? current.user_queued_at : fields.userQueuedAt,
        now: fields.now,
      });
    return this.getVideo(videoId)!;
  }

  /** A row action from the user. Download and Retry put the video at the front of the lane with fresh attempts. */
  applyUserAction(videoId: string, action: UserAction, now: string): VideoRow {
    const current = this.getVideo(videoId);
    if (!current) throw new Error(`Unknown video ${videoId}`);
    const { from, to } = USER_ACTIONS[action];
    if (!from.includes(current.status)) throw new IllegalTransitionError(videoId, current.status, to);
    if (to === "skipped") return this.setStatus(videoId, "skipped", { skipKind: "user", now });
    if (current.status === "queued") {
      this.db
        .prepare("UPDATE youtube_videos SET user_queued_at = ?, retry_after = NULL, attempts = 0, updated_at = ? WHERE video_id = ?")
        .run(now, now, videoId);
      return this.getVideo(videoId)!;
    }
    return this.setStatus(videoId, "queued", { attempts: 0, userQueuedAt: now, now });
  }

  /** Refreshes what the downloaded info JSON knows better than the flat listing. */
  updateMetadata(videoId: string, meta: VideoMetadata, now: string): void {
    this.db
      .prepare(`
        UPDATE youtube_videos SET
          title = COALESCE(NULLIF(@title, ''), title), channel = COALESCE(@channel, channel),
          duration_s = COALESCE(@durationS, duration_s), published_at = COALESCE(@publishedAt, published_at), updated_at = @now
        WHERE video_id = @videoId
      `)
      .run({ videoId, title: meta.title ?? null, channel: meta.channel ?? null, durationS: meta.durationS ?? null, publishedAt: meta.publishedAt ?? null, now });
  }

  videosInStatus(status: VideoStatus): VideoRow[] {
    return this.db.prepare("SELECT * FROM youtube_videos WHERE status = ? ORDER BY video_id").all(status) as VideoRow[];
  }

  /**
   * The next video the download lane should take from the given playlists.
   * The user's picks go first, then videos found by later checks (newest
   * check first), then the rest in playlist order. Videos removed from the
   * playlist wait unless the user asked for them.
   */
  nextQueued(playlistIds: string[], now: string): VideoRow | undefined {
    return this.db
      .prepare(`
        SELECT v.* FROM youtube_videos v
        JOIN youtube_playlist_items i ON i.playlist_id = v.playlist_id AND i.video_id = v.video_id
        WHERE v.status = 'queued'
          AND v.playlist_id IN (SELECT value FROM json_each(@playlistIds))
          AND (v.retry_after IS NULL OR v.retry_after <= @now)
          AND (i.removed_at IS NULL OR v.user_queued_at IS NOT NULL)
        ORDER BY v.user_queued_at IS NULL, v.user_queued_at, i.first_seen_at DESC, i.position
        LIMIT 1
      `)
      .get({ playlistIds: JSON.stringify(playlistIds), now }) as VideoRow | undefined;
  }

  /** Waiting videos whose retry time has come. */
  dueWaiting(now: string): VideoRow[] {
    return this.db
      .prepare("SELECT * FROM youtube_videos WHERE status = 'waiting' AND (retry_after IS NULL OR retry_after <= ?) ORDER BY video_id")
      .all(now) as VideoRow[];
  }

  getCooldown(): Cooldown | null {
    const row = this.db.prepare("SELECT value FROM youtube_sync_state WHERE key = ?").get(COOLDOWN_KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Cooldown) : null;
  }

  /** The cooldown still in force at `now`, if any. */
  activeCooldown(now: Date): Cooldown | null {
    const cooldown = this.getCooldown();
    return cooldown && Date.parse(cooldown.until) > now.getTime() ? cooldown : null;
  }

  /** Pauses the lane for an hour, doubling with each strike since the last success, up to a day. */
  startCooldown(cause: CooldownCause, now: Date): Cooldown {
    const strikes = (this.getCooldown()?.strikes ?? 0) + 1;
    const ms = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (strikes - 1));
    const cooldown: Cooldown = { until: new Date(now.getTime() + ms).toISOString(), cause, strikes };
    this.db
      .prepare("INSERT INTO youtube_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(COOLDOWN_KEY, JSON.stringify(cooldown));
    return cooldown;
  }

  /** A successful download ends the strike count. */
  clearCooldown(): void {
    this.db.prepare("DELETE FROM youtube_sync_state WHERE key = ?").run(COOLDOWN_KEY);
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
