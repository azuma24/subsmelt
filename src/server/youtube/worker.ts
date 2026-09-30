import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../config.js";
import { logger } from "../logger.js";
import { normalizeMediaSubfolder, resolveMediaSubfolder } from "../media-paths.js";
import { MEDIA_DIR } from "../scanner.js";
import { broadcast } from "../sse.js";
import { fetchAddedDates } from "./data-api.js";
import { downloadVideo, findDownloadedMedia, upcomingRetryAt, type DownloadResult } from "./download.js";
import { findPlaylist, readPlaylists, savePlaylist, type YoutubePlaylist } from "./playlists.js";
import type { Cooldown, CooldownCause, VideoRow, YoutubeStore } from "./store.js";
import { exactUploadDateWithYtdlp, listPlaylistWithYtdlp, syncPlaylist, type SyncDeps, type SyncResult } from "./sync.js";
import type { VideoStatus } from "./video-status.js";
import { classifyYtdlpError, type YtdlpErrorClass } from "./ytdlp.js";

const TICK_MS = 30_000;
// Waits after the first, second and third ordinary failure; the fourth sets failed.
const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const PROGRESS_EVERY_MS = 500;
const PROGRESS_STEP = 5;

let lane: Promise<unknown> = Promise.resolve();

/**
 * Every yt-dlp call that reaches YouTube runs here, one at a time, so a
 * download, a playlist check, a preview and a date lookup never hit YouTube together.
 */
export function onYoutubeLane<T>(task: () => Promise<T>): Promise<T> {
  const run = lane.then(task, task);
  lane = run.catch(() => undefined);
  return run;
}

export function youtubeTmpRoot(): string {
  return path.resolve(process.env.DATA_DIR || "./data", "youtube", "tmp");
}

export class CooldownError extends Error {
  constructor(readonly cooldown: Cooldown) {
    super(`YouTube asked SubSmelt to slow down. Requests to YouTube pause until ${cooldown.until}`);
    this.name = "CooldownError";
  }
}

export class PlaylistGoneError extends Error {
  constructor(id: string) {
    super(`Playlist ${id} is no longer followed`);
    this.name = "PlaylistGoneError";
  }
}

export function liveSyncDeps(): SyncDeps {
  return {
    listPlaylist: listPlaylistWithYtdlp,
    exactUploadDate: exactUploadDateWithYtdlp,
    addedDates: async (playlistId) => {
      const key = getSetting("youtube_api_key");
      return key ? fetchAddedDates(playlistId, key) : null;
    },
    now: () => new Date(),
  };
}

export function nextCheckAt(playlist: YoutubePlaylist, lastCheckedAt: string | null): string | null {
  if (!playlist.enabled) return null;
  if (!lastCheckedAt) return new Date(0).toISOString();
  return new Date(Date.parse(lastCheckedAt) + playlist.checkEveryMinutes * 60_000).toISOString();
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isCooldownCause = (cls: YtdlpErrorClass): cls is CooldownCause => cls === "rate_limited" || cls === "bot_check";

export interface PlaylistFolder {
  /** Where the files go. */
  abs: string;
  /** The same folder relative to MEDIA_DIR, as stored in media_path. */
  rel: string;
}

/** The playlist's download folder, or null when the settings point outside the media folder. */
export function playlistFolder(playlist: YoutubePlaylist): PlaylistFolder | null {
  const base = normalizeMediaSubfolder(getSetting("youtube_download_dir"));
  const rel = base ? normalizeMediaSubfolder(`${base}/${playlist.folder}`) : null;
  const abs = rel ? resolveMediaSubfolder(rel, MEDIA_DIR) : null;
  return rel && abs ? { abs, rel } : null;
}

export interface WorkerOptions {
  now?: () => Date;
  announce?: (event: string, data: Record<string, unknown>) => void;
}

export interface ReconcileResult {
  requeued: number;
  adopted: number;
}

/**
 * Owns the YouTube lane: scheduled playlist checks, the serial download step,
 * the cooldown after YouTube pushes back, and the boot reconciliation that
 * makes a restart at any point converge.
 */
export class YoutubeWorker {
  private readonly now: () => Date;
  private readonly announce: (event: string, data: Record<string, unknown>) => void;
  private readonly checks = new Map<string, Promise<SyncResult>>();
  private readonly progress = new Map<string, number>();
  private readonly abort = new AbortController();
  private passScheduled = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly store: YoutubeStore, options: WorkerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.announce = options.announce ?? broadcast;
  }

  start(): void {
    const { requeued, adopted } = this.reconcile();
    if (requeued || adopted) logger.info("youtube", `Boot: ${requeued} interrupted download(s) queued again, ${adopted} already on disk`);
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Stops without touching video rows, as a crash would; the next boot reconciles them. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
  }

  tick(): void {
    this.checkDuePlaylists();
    this.kick();
  }

  /**
   * Clears every scratch folder, puts interrupted downloads back in the
   * queue, and moves queued videos whose file is already in the playlist
   * folder past the download. Running it twice changes nothing more.
   */
  reconcile(): ReconcileResult {
    fs.rmSync(youtubeTmpRoot(), { recursive: true, force: true });
    const nowIso = this.now().toISOString();
    let requeued = 0;
    for (const video of this.store.videosInStatus("downloading")) {
      this.move(video, "queued", { now: nowIso, retryAfter: video.retry_after });
      requeued += 1;
    }
    let adopted = 0;
    for (const video of this.store.videosInStatus("queued")) {
      const playlist = findPlaylist(video.playlist_id);
      const folder = playlist ? playlistFolder(playlist) : null;
      if (folder && this.adoptExisting(video, folder)) adopted += 1;
    }
    return { requeued, adopted };
  }

  activeCooldown(): Cooldown | null {
    return this.store.activeCooldown(this.now());
  }

  /** The last reported download percentage of a video in progress. */
  progressOf(videoId: string): number | undefined {
    return this.progress.get(videoId);
  }

  /** Runs a YouTube call on the lane, refused while a cooldown is in force when its turn comes. */
  youtubeCall<T>(task: () => Promise<T>): Promise<T> {
    return onYoutubeLane(async () => {
      const cooldown = this.activeCooldown();
      if (cooldown) throw new CooldownError(cooldown);
      try {
        return await task();
      } catch (error) {
        const cls = classifyYtdlpError(message(error));
        if (isCooldownCause(cls)) this.enterCooldown(cls);
        throw error;
      }
    });
  }

  isChecking(playlistId: string): boolean {
    return this.checks.has(playlistId);
  }

  /**
   * Starts a check of one playlist, or joins the one already running. After
   * a (re-)follow, `asNewFollow` queues a first sync behind any check still
   * running for the old follow, whose settings may be stale.
   */
  checkPlaylist(playlist: YoutubePlaylist, { asNewFollow = false } = {}): Promise<SyncResult> {
    const running = this.checks.get(playlist.id);
    if (running && !asNewFollow) return running;
    const start = () => this.syncAndAnnounce(playlist, asNewFollow);
    const run: Promise<SyncResult> = (running ? running.then(start, start) : start()).finally(() => {
      if (this.checks.get(playlist.id) === run) this.checks.delete(playlist.id);
    });
    this.checks.set(playlist.id, run);
    return run;
  }

  /** Schedules a pass of the download step on the lane unless one is already waiting. */
  kick(): void {
    if (this.passScheduled || this.stopped) return;
    this.passScheduled = true;
    onYoutubeLane(() => {
      this.passScheduled = false;
      return this.downloadNext();
    })
      .then((worked) => {
        if (worked) this.kick();
      })
      .catch((error) => logger.error("youtube", `Download step failed: ${message(error)}`));
  }

  /** Runs download passes until nothing is left to take. */
  async drain(): Promise<void> {
    while (await onYoutubeLane(() => this.downloadNext()));
  }

  private async syncAndAnnounce(playlist: YoutubePlaylist, firstSync: boolean): Promise<SyncResult> {
    this.announce("youtube:playlist", { playlistId: playlist.id, checking: true });
    try {
      // Re-read when the lane reaches us: the playlist may have been edited or unfollowed while queued.
      const result = await this.youtubeCall(() => {
        const fresh = findPlaylist(playlist.id);
        if (!fresh) throw new PlaylistGoneError(playlist.id);
        if (firstSync) this.store.deleteSyncState(playlist.id);
        return syncPlaylist(this.store, fresh, liveSyncDeps());
      });
      const current = findPlaylist(playlist.id);
      if (!current) this.store.deleteSyncState(playlist.id);
      else if (result.title && current.title !== result.title) savePlaylist({ ...current, title: result.title });
      const { lastCheckedAt } = this.store.getSyncState(playlist.id);
      logger.info("youtube", `Checked playlist ${result.title}: ${result.total} listed, ${result.added} new, ${result.removed} removed`);
      this.announce("youtube:playlist", { playlistId: playlist.id, lastCheckedAt });
      this.kick();
      return result;
    } catch (error) {
      if (error instanceof PlaylistGoneError) throw error;
      logger.error("youtube", `Checking playlist ${playlist.title} failed: ${message(error)}`);
      this.announce("youtube:playlist", { playlistId: playlist.id, lastCheckedAt: this.store.getSyncState(playlist.id).lastCheckedAt, error: message(error) });
      throw error;
    }
  }

  private checkDuePlaylists(): void {
    if (this.stopped || this.activeCooldown()) return;
    const now = this.now().getTime();
    for (const playlist of readPlaylists()) {
      const due = nextCheckAt(playlist, this.store.getSyncState(playlist.id).lastCheckedAt);
      if (due && Date.parse(due) <= now) this.checkPlaylist(playlist).catch(() => undefined);
    }
  }

  private move(video: VideoRow, to: VideoStatus, fields: Parameters<YoutubeStore["setStatus"]>[2]): VideoRow {
    const row = this.store.setStatus(video.video_id, to, fields);
    this.announce("youtube:video", { videoId: row.video_id, playlistId: row.playlist_id, status: row.status });
    return row;
  }

  private enterCooldown(cause: CooldownCause): void {
    const cooldown = this.store.startCooldown(cause, this.now());
    logger.warn("youtube", `YouTube pushed back (${cause}); YouTube requests pause until ${cooldown.until}`);
    this.announce("youtube:cooldown", { until: cooldown.until, cause: cooldown.cause });
  }

  /** A queued video whose file is already in the playlist folder skips the download. */
  private adoptExisting(video: VideoRow, folder: PlaylistFolder): boolean {
    const file = findDownloadedMedia(folder.abs, video.video_id);
    if (!file) return false;
    const nowIso = this.now().toISOString();
    this.store.setStatus(video.video_id, "downloading", { now: nowIso });
    this.move(video, "transcribing", { now: nowIso, attempts: 0, mediaPath: `${folder.rel}/${file}` });
    return true;
  }

  /** Takes the next queued video and downloads it. False when there was nothing to take. */
  private async downloadNext(): Promise<boolean> {
    if (this.stopped) return false;
    const nowIso = this.now().toISOString();
    for (const video of this.store.dueWaiting(nowIso)) this.move(video, "queued", { now: nowIso });
    if (this.activeCooldown()) return false;

    const playlists = readPlaylists();
    const video = this.store.nextQueued(playlists.map((p) => p.id), nowIso);
    if (!video) return false;
    const playlist = playlists.find((p) => p.id === video.playlist_id)!;
    const folder = playlistFolder(playlist);
    if (!folder) {
      this.store.setStatus(video.video_id, "downloading", { now: nowIso });
      this.move(video, "failed", { now: nowIso, reason: "The YouTube download folder is not inside the media folder" });
      return true;
    }
    if (this.adoptExisting(video, folder)) return true;

    this.move(video, "downloading", { now: nowIso, retryAfter: null });
    const result = await downloadVideo({
      videoId: video.video_id,
      durationS: video.duration_s,
      profile: playlist.media,
      tmpDir: path.join(youtubeTmpRoot(), video.video_id),
      destDir: folder.abs,
      onProgress: this.progressReporter(video),
      signal: this.abort.signal,
    }).catch((error): DownloadResult => ({ ok: false, errorClass: "other", message: message(error) }));
    this.progress.delete(video.video_id);
    // Shutting down mid-download: the row stays downloading for the next boot to reconcile.
    if (this.stopped) return false;
    this.settle(video, folder, result);
    return true;
  }

  /** Records every percentage; announces one when it moved 5 points or half a second passed. */
  private progressReporter(video: VideoRow): (pct: number) => void {
    let lastAt = 0;
    let lastSent = -PROGRESS_STEP;
    return (pct) => {
      if (this.progress.get(video.video_id) === pct) return;
      this.progress.set(video.video_id, pct);
      const at = Date.now();
      if (pct - lastSent < PROGRESS_STEP && at - lastAt < PROGRESS_EVERY_MS) return;
      lastAt = at;
      lastSent = pct;
      this.announce("youtube:video", { videoId: video.video_id, playlistId: video.playlist_id, status: "downloading", pct });
    };
  }

  private settle(video: VideoRow, folder: PlaylistFolder, result: DownloadResult): void {
    const nowIso = this.now().toISOString();
    if (result.ok) {
      this.store.updateMetadata(video.video_id, result.meta, nowIso);
      this.store.clearCooldown();
      this.move(video, "transcribing", { now: nowIso, attempts: 0, mediaPath: `${folder.rel}/${result.mediaFile}` });
      logger.info("youtube", `Downloaded ${result.mediaFile} into ${folder.rel}`);
      return;
    }
    logger.warn("youtube", `Download of ${video.video_id} failed (${result.errorClass}): ${result.message}`);
    const reason = result.message;
    switch (result.errorClass) {
      case "rate_limited":
      case "bot_check":
        this.move(video, "queued", { now: nowIso, reason });
        this.enterCooldown(result.errorClass);
        return;
      case "unavailable":
        this.move(video, "unavailable", { now: nowIso, reason });
        return;
      case "members_only":
        this.move(video, "skipped", { now: nowIso, skipKind: "members_only", reason });
        return;
      case "upcoming":
        this.move(video, "waiting", { now: nowIso, reason, retryAfter: upcomingRetryAt(reason, this.now()) });
        return;
      case "format":
        this.move(video, "failed", { now: nowIso, reason });
        return;
      case "other": {
        const attempts = video.attempts + 1;
        if (attempts > BACKOFF_MS.length) {
          this.move(video, "failed", { now: nowIso, reason, attempts });
          return;
        }
        const retryAfter = new Date(this.now().getTime() + BACKOFF_MS[attempts - 1]).toISOString();
        this.move(video, "queued", { now: nowIso, reason, attempts, retryAfter });
      }
    }
  }
}
