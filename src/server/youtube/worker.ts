import fs from "node:fs";
import path from "node:path";
import { getAllSettings, getSetting } from "../config.js";
import { countOpenJobsForSubtitle } from "../db.js";
import { gpuShared, setYoutubeBacklogSource, transcriptionMayStart } from "../gpu-gate.js";
import { logger } from "../logger.js";
import { normalizeMediaSubfolder, resolveMediaSubfolder } from "../media-paths.js";
import { isQueueRunning, processQueue, startHeldQueue } from "../queue.js";
import { getTranscriptionBackendUrl, runTranscriptionAttempt } from "../routes/transcription-runtime.js";
import { MEDIA_DIR } from "../scanner.js";
import { broadcast } from "../sse.js";
import { fetchAddedDates } from "./data-api.js";
import { downloadVideo, findDownloadedMedia, tidyPlaylistFolder, upcomingRetryAt, type DownloadResult } from "./download.js";
import { findPlaylist, readPlaylists, savePlaylist, type YoutubePlaylist } from "./playlists.js";
import type { Cooldown, CooldownCause, VideoRow, YoutubeStore } from "./store.js";
import { fetchCaptionWithYtdlp, produceSubtitles, type TranscribeRequest, type TranscribeResult } from "./subtitles.js";
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

/** The subtitle step cannot run yet; the video keeps its place and attempts. */
class NotYetError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotYetError";
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
    isFollowed: (playlistId) => Boolean(findPlaylist(playlistId)),
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

/** The translation queue as the worker sees it. */
export interface QueueControl {
  /** Starts a run through the GPU gate. */
  start: () => void;
  /** Starts a run the gate held back, if it has opened. */
  startHeld: () => void;
  running: () => boolean;
}

export interface WorkerOptions {
  now?: () => Date;
  announce?: (event: string, data: Record<string, unknown>) => void;
  transcribe?: (req: TranscribeRequest, onProgress: (pct: number) => void) => Promise<TranscribeResult>;
  queue?: QueueControl;
}

const liveQueue: QueueControl = { start: () => void processQueue(), startHeld: startHeldQueue, running: isQueueRunning };

function transcriptionReady(settings = getAllSettings()): boolean {
  return settings.transcription_enabled === "1" && Boolean(getTranscriptionBackendUrl(settings));
}

/** Whisper through the app's own transcription path, with at least the video's length as its timeout. */
export async function transcribeWithWhisper(req: TranscribeRequest, onProgress: (pct: number) => void): Promise<TranscribeResult> {
  const settings = getAllSettings();
  if (!transcriptionReady(settings)) throw new NotYetError("Transcription waits for a backend");
  const timeoutS = Math.max(Number.parseInt(settings.transcription_request_timeout_s, 10) || 1800, req.durationS ?? 0);
  const { result, outputPath } = await runTranscriptionAttempt({
    videoPath: req.mediaPath,
    postAction: "transcribe_only",
    outputFormat: "srt",
    overrides: { language: req.language },
    settings: { ...settings, transcription_request_timeout_s: String(timeoutS) },
    onProgress,
  });
  return { outputPath, language: typeof result.language === "string" && result.language ? result.language : null };
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
  private readonly transcribe: NonNullable<WorkerOptions["transcribe"]>;
  private readonly queue: QueueControl;
  private passScheduled = false;
  private subtitlePassScheduled = false;
  private subtitleLane: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly store: YoutubeStore, options: WorkerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.announce = options.announce ?? broadcast;
    this.transcribe = options.transcribe ?? transcribeWithWhisper;
    this.queue = options.queue ?? liveQueue;
  }

  start(): void {
    const { requeued, adopted } = this.reconcile();
    if (requeued || adopted) logger.info("youtube", `Boot: ${requeued} interrupted download(s) queued again, ${adopted} already on disk`);
    setYoutubeBacklogSource(() => this.whisperBacklog());
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
    this.kickSubtitles();
    this.finishTranslated();
    this.queue.startHeld();
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

  /** Schedules a pass of the subtitle step unless one is already waiting. */
  kickSubtitles(): void {
    if (this.subtitlePassScheduled || this.stopped) return;
    this.subtitlePassScheduled = true;
    this.onSubtitleLane(() => {
      this.subtitlePassScheduled = false;
      return this.subtitleNext();
    })
      .then((worked) => {
        if (worked) this.kickSubtitles();
      })
      .catch((error) => logger.error("youtube", `Subtitle step failed: ${message(error)}`));
  }

  /** Runs subtitle passes until no video is ready for one. */
  async drainSubtitles(): Promise<void> {
    while (await this.onSubtitleLane(() => this.subtitleNext()));
  }

  /**
   * Moves every translating video whose translation jobs have all settled
   * on to its note. A failed translation settles too; the Jobs page shows it.
   */
  finishTranslated(): void {
    for (const video of this.store.videosInStatus("translating")) {
      if (!video.subtitle_path) continue;
      if (countOpenJobsForSubtitle(path.join(MEDIA_DIR, video.subtitle_path)) > 0) continue;
      this.onSubtitlesComplete(video.video_id);
    }
  }

  /**
   * The hook point for the note export: subtitles and every translation of
   * the video are finished. Until notes exist the video is done here.
   */
  onSubtitlesComplete(videoId: string): void {
    const video = this.store.getVideo(videoId);
    if (video?.status !== "translating") return;
    this.move(video, "done", { now: this.now().toISOString() });
    logger.info("youtube", `Subtitles and translations of ${video.title} are finished`);
  }

  /** Videos that will still need Whisper. Queued ones wait out a cooldown and do not count during it. */
  whisperBacklog(): number {
    const totals = this.store.statusTotals();
    const queued = this.activeCooldown() ? 0 : totals.queued ?? 0;
    const transcribing = transcriptionReady() ? totals.transcribing ?? 0 : 0;
    return queued + (totals.downloading ?? 0) + transcribing;
  }

  private onSubtitleLane<T>(task: () => Promise<T>): Promise<T> {
    const run = this.subtitleLane.then(task, task);
    this.subtitleLane = run.catch(() => undefined);
    return run;
  }

  /** Makes the subtitles of the next downloaded video. False when no video could be taken. */
  private async subtitleNext(): Promise<boolean> {
    if (this.stopped) return false;
    const nowIso = this.now().toISOString();
    const video = this.store.videosInStatus("transcribing").find((v) => v.media_path && (!v.retry_after || v.retry_after <= nowIso));
    if (!video) return false;
    const playlist = findPlaylist(video.playlist_id);
    const mediaPath = path.join(MEDIA_DIR, video.media_path!);
    const report = this.progressReporter(video, "transcribing");
    try {
      const result = await produceSubtitles({
        videoId: video.video_id,
        mediaPath,
        durationS: video.duration_s,
        knownTranscript: video.subtitle_path ? path.join(MEDIA_DIR, video.subtitle_path) : null,
        playlist,
      }, {
        fetchCaption: (videoId, lang, dest) =>
          this.youtubeCall(() => fetchCaptionWithYtdlp(videoId, lang, dest, path.join(youtubeTmpRoot(), `${videoId}-captions`))),
        onCaptionError: (lang, error) => {
          // YouTube pushed back, now or on an earlier call: the captions are still worth waiting for.
          const cooldown = this.activeCooldown();
          if (cooldown) throw new NotYetError(new CooldownError(cooldown).message);
          logger.warn("youtube", `Captions ${lang} of ${video.video_id} could not be fetched: ${message(error)}`);
        },
        transcribe: (req) => {
          if (!transcriptionMayStart(gpuShared(), this.queue.running())) throw new NotYetError("Transcription waits for the translation batch to finish");
          return this.transcribe(req, report);
        },
      });
      this.progress.delete(video.video_id);
      const subtitlePath = path.relative(MEDIA_DIR, result.transcriptPath).split(path.sep).join("/");
      this.move(video, "translating", { now: this.now().toISOString(), attempts: 0, subtitlePath });
      logger.info("youtube", `Subtitles of ${video.title}: transcript from ${result.source}, ${result.routes.map((r) => r.kind).join(", ") || "no other languages"}`);
      if (result.jobsCreated > 0) this.queue.start();
      this.finishTranslated();
      this.queue.startHeld();
      return true;
    } catch (error) {
      this.progress.delete(video.video_id);
      // Nothing is wrong with the video: the backend, the GPU or YouTube is not free yet.
      if (error instanceof NotYetError) return false;
      this.retryOrFail(video, "transcribing", message(error));
      return true;
    }
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
    // Queued videos stop holding translation while YouTube is paused.
    this.queue.startHeld();
  }

  /** An ordinary failure: back off 10 minutes, an hour, then 6 hours; the fourth failure sets failed. */
  private retryOrFail(video: VideoRow, retryStatus: "queued" | "transcribing", reason: string): void {
    const nowIso = this.now().toISOString();
    const attempts = video.attempts + 1;
    if (attempts > BACKOFF_MS.length) {
      this.move(video, "failed", { now: nowIso, reason, attempts });
      return;
    }
    const retryAfter = new Date(this.now().getTime() + BACKOFF_MS[attempts - 1]).toISOString();
    this.move(video, retryStatus, { now: nowIso, reason, attempts, retryAfter });
  }

  /** A queued video whose file is already in the playlist folder skips the download. */
  private adoptExisting(video: VideoRow, folder: PlaylistFolder): boolean {
    const meta = tidyPlaylistFolder(folder.abs, video.video_id);
    const file = findDownloadedMedia(folder.abs, video.video_id);
    if (!file) return false;
    const nowIso = this.now().toISOString();
    this.store.updateMetadata(video.video_id, meta, nowIso);
    this.store.setStatus(video.video_id, "downloading", { now: nowIso });
    this.move(video, "transcribing", { now: nowIso, attempts: 0, mediaPath: `${folder.rel}/${file}` });
    this.kickSubtitles();
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
      onProgress: this.progressReporter(video, "downloading"),
      signal: this.abort.signal,
    }).catch((error): DownloadResult => ({ ok: false, errorClass: "other", message: message(error) }));
    this.progress.delete(video.video_id);
    // Shutting down mid-download: the row stays downloading for the next boot to reconcile.
    if (this.stopped) return false;
    this.settle(video, folder, result);
    return true;
  }

  /** Records every percentage; announces one when it moved 5 points or half a second passed. */
  private progressReporter(video: VideoRow, status: "downloading" | "transcribing"): (pct: number) => void {
    let lastAt = 0;
    let lastSent = -PROGRESS_STEP;
    return (pct) => {
      if (this.progress.get(video.video_id) === pct) return;
      this.progress.set(video.video_id, pct);
      const at = Date.now();
      if (pct - lastSent < PROGRESS_STEP && at - lastAt < PROGRESS_EVERY_MS) return;
      lastAt = at;
      lastSent = pct;
      this.announce("youtube:video", { videoId: video.video_id, playlistId: video.playlist_id, status, pct });
    };
  }

  private settle(video: VideoRow, folder: PlaylistFolder, result: DownloadResult): void {
    const nowIso = this.now().toISOString();
    if (result.ok) {
      this.store.updateMetadata(video.video_id, result.meta, nowIso);
      this.store.clearCooldown();
      this.move(video, "transcribing", { now: nowIso, attempts: 0, mediaPath: `${folder.rel}/${result.mediaFile}` });
      logger.info("youtube", `Downloaded ${result.mediaFile} into ${folder.rel}`);
      this.kickSubtitles();
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
      case "other":
        this.retryOrFail(video, "queued", reason);
    }
  }
}
