import fs from "node:fs";
import path from "node:path";
import { getAllSettings, getSetting } from "../config.js";
import { countOpenJobsForSubtitle } from "../db.js";
import { gpuShared, setYoutubeBacklogSource, transcriptionMayStart } from "../gpu-gate.js";
import { logger } from "../logger.js";
import { normalizeMediaSubfolder, resolveMediaSubfolder } from "../media-paths.js";
import { isQueueRunning, runQueueSafely, startHeldQueue } from "../queue.js";
import { getTranscriptionBackendUrl, runTranscriptionAttempt } from "../routes/transcription-runtime.js";
import { MEDIA_DIR } from "../scanner.js";
import { broadcast } from "../sse.js";
import { fetchAddedDates } from "./data-api.js";
import {
  downloadVideo,
  findDownloadedMedia,
  tidyPlaylistFolder,
  upcomingRetryAt,
  type DownloadResult,
} from "./download.js";
import { findPlaylist, readPlaylists, savePlaylist, type YoutubePlaylist } from "./playlists.js";
import type { Cooldown, CooldownCause, VideoRow, YoutubeStore } from "./store.js";
import { fetchCaptionWithYtdlp, produceSubtitles, type TranscribeRequest, type TranscribeResult } from "./subtitles.js";
import { exportNoteForVideo } from "./note-export.js";
import {
  exactUploadDateWithYtdlp,
  listFollowedWithYtdlp,
  syncPlaylist,
  type SyncDeps,
  type SyncResult,
} from "./sync.js";
import type { VideoStatus } from "./video-status.js";
import { classifyYtdlpError, youtubeTmpRoot, type YtdlpErrorClass } from "./ytdlp.js";
import { errorMessage } from "../errors.js";

const TICK_MS = 30_000;
// Waits after the first, second and third ordinary failure; the fourth sets failed.
const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
// A video whose subtitles cannot be made yet looks again after this; asking YouTube again waits longer.
const NOT_YET_MS = 2 * 60_000;
const NOT_YET_AFTER_YOUTUBE_MS = 60 * 60_000;
const PROGRESS_EVERY_MS = 500;
const PROGRESS_STEP = 5;

type Lane = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs tasks one at a time, in the order they were handed in. */
function serialLane(): Lane {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * yt-dlp calls that reach YouTube run on two lanes, one call at a time on
 * each. The video lane takes a video's download and its caption fetches,
 * which can hold it for an hour. The metadata lane takes the short calls a
 * person may be waiting on (a preview, a check, a date lookup), so they never
 * queue behind a download. A download spends its time on YouTube's media
 * servers, so at most one listing beside it adds little. Both lanes refuse
 * calls during a cooldown and either one can start it.
 */
const onVideoLane = serialLane();
const onMetadataLane = serialLane();

export { youtubeTmpRoot };

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
    listPlaylist: listFollowedWithYtdlp,
    exactUploadDate: exactUploadDateWithYtdlp,
    addedDates: async (playlistId) => {
      const key = getSetting("youtube_api_key");
      return key ? fetchAddedDates(playlistId, key) : null;
    },
    isFollowed: (playlistId) => Boolean(findPlaylist(playlistId)),
    currentPlaylist: findPlaylist,
    now: () => new Date(),
  };
}

export function nextCheckAt(playlist: YoutubePlaylist, lastCheckedAt: string | null): string | null {
  if (!playlist.enabled) return null;
  if (!lastCheckedAt) return new Date(0).toISOString();
  return new Date(Date.parse(lastCheckedAt) + playlist.checkEveryMinutes * 60_000).toISOString();
}

const message = (error: unknown) => (error instanceof Error ? errorMessage(error) : String(error));

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

const liveQueue: QueueControl = { start: () => runQueueSafely(), startHeld: startHeldQueue, running: isQueueRunning };

export function transcriptionReady(settings = getAllSettings()): boolean {
  return settings.transcription_enabled === "1" && Boolean(getTranscriptionBackendUrl(settings));
}

/** Whisper through the app's own transcription path, with at least the video's length as its timeout. */
export async function transcribeWithWhisper(
  req: TranscribeRequest,
  onProgress: (pct: number) => void,
): Promise<TranscribeResult> {
  const settings = getAllSettings();
  if (!transcriptionReady(settings)) throw new NotYetError("Transcription waits for a backend");
  const timeoutS = Math.max(Number.parseInt(settings.transcription_request_timeout_s, 10) || 1800, req.durationS ?? 0);
  const { result, outputPath, model } = await runTranscriptionAttempt({
    videoPath: req.mediaPath,
    postAction: "transcribe_only",
    outputFormat: "srt",
    overrides: { language: req.language },
    settings: { ...settings, transcription_request_timeout_s: String(timeoutS) },
    onProgress,
  });
  return {
    outputPath,
    model,
    language: typeof result.language === "string" && result.language ? result.language : null,
  };
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
  /** Videos whose onSubtitlesComplete is still running. */
  private readonly completing = new Set<string>();
  private readonly abort = new AbortController();
  private readonly transcribe: NonNullable<WorkerOptions["transcribe"]>;
  private readonly queue: QueueControl;
  private passScheduled = false;
  private subtitlePassScheduled = false;
  private subtitleLane: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: YoutubeStore,
    options: WorkerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.announce = options.announce ?? broadcast;
    this.transcribe = options.transcribe ?? transcribeWithWhisper;
    this.queue = options.queue ?? liveQueue;
  }

  start(): void {
    const { requeued, adopted } = this.reconcile();
    if (requeued || adopted)
      logger.info("youtube", `Boot: ${requeued} interrupted download(s) queued again, ${adopted} already on disk`);
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
    // A store read or a note export failing here must not become an unhandled
    // rejection — the worker keeps ticking and the next pass retried it.
    this.finishTranslated().catch((error) =>
      logger.error("youtube", `Finishing translated videos failed: ${message(error)}`),
    );
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

  /** Runs a video's YouTube call on the video lane, refused while a cooldown is in force when its turn comes. */
  videoCall<T>(task: () => Promise<T>): Promise<T> {
    return this.guarded(onVideoLane, task);
  }

  /** Runs a short metadata call (listing, lookup) on the metadata lane, with the same cooldown rules. */
  metadataCall<T>(task: () => Promise<T>): Promise<T> {
    return this.guarded(onMetadataLane, task);
  }

  /** Sync deps whose every yt-dlp call is its own metadata-lane turn, so a long first sync never holds the lane. */
  syncDeps(): SyncDeps {
    const live = liveSyncDeps();
    return {
      ...live,
      listPlaylist: (id) =>
        this.metadataCall(() => {
          // Re-read when the lane reaches us: the playlist may have been unfollowed while queued.
          if (!findPlaylist(id)) throw new PlaylistGoneError(id);
          return live.listPlaylist(id);
        }),
      exactUploadDate: (videoId) => this.metadataCall(() => live.exactUploadDate(videoId)),
    };
  }

  private guarded<T>(lane: Lane, task: () => Promise<T>): Promise<T> {
    return lane(async () => {
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
    onVideoLane(() => {
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
    while (await onVideoLane(() => this.downloadNext()));
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
   * Hands every translating video whose translation jobs have all settled to
   * onSubtitlesComplete. A failed translation settles too; the Jobs page shows it.
   */
  finishTranslated(): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const video of this.store.videosInStatus("translating")) {
      if (!video.subtitle_path || this.completing.has(video.video_id)) continue;
      if (countOpenJobsForSubtitle(path.join(MEDIA_DIR, video.subtitle_path)) > 0) continue;
      this.completing.add(video.video_id);
      runs.push(this.onSubtitlesComplete(video.video_id).finally(() => this.completing.delete(video.video_id)));
    }
    return Promise.all(runs).then(() => undefined);
  }

  /**
   * The one place a video leaves translating: its subtitles and every
   * translation are finished. The note export goes inside the try; when it
   * throws, the video stays translating with the error as its reason and the
   * next tick tries again.
   */
  async onSubtitlesComplete(videoId: string): Promise<void> {
    const video = this.store.getVideo(videoId);
    if (video?.status !== "translating") return;
    try {
      await exportNoteForVideo({ store: this.store, announce: this.announce }, videoId);
      this.move(video, "done", { now: this.now().toISOString() });
      logger.info("youtube", `Subtitles and translations of ${video.title} are finished`);
    } catch (error) {
      this.store.setReason(videoId, message(error), this.now().toISOString());
      this.announce("youtube:video", { videoId, playlistId: video.playlist_id, status: video.status });
    }
  }

  /** Videos that will still need Whisper. Queued ones wait out a cooldown and do not count during it. */
  whisperBacklog(): number {
    const totals = this.store.statusTotals();
    const queued = this.activeCooldown() ? 0 : (totals.queued ?? 0);
    const transcribing = transcriptionReady() ? (totals.transcribing ?? 0) : 0;
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
    const video = this.store
      .videosInStatus("transcribing")
      .find((v) => v.media_path && (!v.retry_after || v.retry_after <= nowIso));
    if (!video) return false;
    const playlist = findPlaylist(video.playlist_id);
    const mediaPath = path.join(MEDIA_DIR, video.media_path!);
    const report = this.progressReporter(video, "transcribing");
    let askedYoutube = false;
    try {
      const result = await produceSubtitles(
        {
          videoId: video.video_id,
          mediaPath,
          durationS: video.duration_s,
          knownTranscript: video.subtitle_path ? path.join(MEDIA_DIR, video.subtitle_path) : null,
          playlist,
        },
        {
          fetchCaption: (videoId, lang, dest) => {
            askedYoutube = true;
            return this.videoCall(() =>
              fetchCaptionWithYtdlp(videoId, lang, dest, path.join(youtubeTmpRoot(), `${videoId}-captions`)),
            );
          },
          onCaptionError: (lang, error) => {
            // YouTube pushed back, now or on an earlier call: the captions are still worth waiting for.
            const cooldown = this.activeCooldown();
            if (cooldown) throw new NotYetError(new CooldownError(cooldown).message);
            logger.warn("youtube", `Captions ${lang} of ${video.video_id} could not be fetched: ${message(error)}`);
          },
          transcribe: (req) => {
            if (!transcriptionMayStart(gpuShared(), this.queue.running()))
              throw new NotYetError("Transcription waits for the translation batch to finish");
            return this.transcribe(req, report);
          },
        },
      );
      this.progress.delete(video.video_id);
      const subtitlePath = path.relative(MEDIA_DIR, result.transcriptPath).split(path.sep).join("/");
      const subtitlePlan = {
        spoken: result.spoken,
        routes: result.routes.map(({ taskId, kind }) => ({ taskId, kind })),
      };
      this.move(video, "translating", {
        now: this.now().toISOString(),
        attempts: 0,
        subtitlePath,
        subtitlePlan,
        ...(result.transcriptSource ? { transcriptSource: result.transcriptSource } : {}),
      });
      logger.info(
        "youtube",
        `Subtitles of ${video.title}: transcript from ${result.transcriptSource ?? "an earlier run"}, ${result.routes.map((r) => r.kind).join(", ") || "no other languages"}`,
      );
      if (result.jobsCreated > 0) this.queue.start();
      await this.finishTranslated();
      this.queue.startHeld();
      return true;
    } catch (error) {
      this.progress.delete(video.video_id);
      // Nothing is wrong with the video: the backend, the GPU or YouTube is not free yet.
      if (error instanceof NotYetError) this.notYet(video, errorMessage(error), askedYoutube);
      else this.retryOrFail(video, "transcribing", message(error));
      return true;
    }
  }

  /**
   * Puts a video whose subtitles cannot be made yet aside, keeping its
   * attempts, so the next video gets its turn. It looks again when a cooldown
   * ends, or after a short wait, or an hour when this pass already asked
   * YouTube for a caption that failed.
   */
  private notYet(video: VideoRow, reason: string, askedYoutube: boolean): void {
    const now = this.now();
    const cooldown = this.activeCooldown();
    const retryAfter =
      cooldown?.until ?? new Date(now.getTime() + (askedYoutube ? NOT_YET_AFTER_YOUTUBE_MS : NOT_YET_MS)).toISOString();
    const row = this.store.setStatus(video.video_id, "transcribing", { now: now.toISOString(), reason, retryAfter });
    // Every waiting video comes round every two minutes; only a new reason is news.
    if (video.reason !== reason)
      this.announce("youtube:video", { videoId: row.video_id, playlistId: row.playlist_id, status: row.status });
  }

  private async syncAndAnnounce(playlist: YoutubePlaylist, firstSync: boolean): Promise<SyncResult> {
    this.announce("youtube:playlist", { playlistId: playlist.id, checking: true });
    try {
      // Re-read: the playlist may have been edited or unfollowed while an earlier check ran.
      const fresh = findPlaylist(playlist.id);
      if (!fresh) throw new PlaylistGoneError(playlist.id);
      const cooldown = this.activeCooldown();
      if (cooldown) throw new CooldownError(cooldown);
      if (firstSync) this.store.deleteSyncState(playlist.id);
      const result = await syncPlaylist(this.store, fresh, this.syncDeps());
      const current = findPlaylist(playlist.id);
      if (!current) this.store.deleteSyncState(playlist.id);
      else if (result.title && current.title !== result.title) savePlaylist({ ...current, title: result.title });
      const { lastCheckedAt } = this.store.getSyncState(playlist.id);
      logger.info(
        "youtube",
        `Checked playlist ${result.title}: ${result.total} listed, ${result.added} new, ${result.removed} removed`,
      );
      this.announce("youtube:playlist", { playlistId: playlist.id, lastCheckedAt });
      this.kick();
      return result;
    } catch (error) {
      if (error instanceof PlaylistGoneError) {
        this.store.deleteSyncState(playlist.id);
        throw error;
      }
      logger.error("youtube", `Checking playlist ${playlist.title} failed: ${message(error)}`);
      this.announce("youtube:playlist", {
        playlistId: playlist.id,
        lastCheckedAt: this.store.getSyncState(playlist.id).lastCheckedAt,
        error: message(error),
      });
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
    const video = this.store.nextQueued(
      playlists.map((p) => p.id),
      nowIso,
    );
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
    const cooldownBefore = this.store.getCooldown();
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
    this.settle(video, folder, result, cooldownBefore);
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

  private settle(
    video: VideoRow,
    folder: PlaylistFolder,
    result: DownloadResult,
    cooldownBefore: Cooldown | null,
  ): void {
    const nowIso = this.now().toISOString();
    if (result.ok) {
      this.store.updateMetadata(video.video_id, result.meta, nowIso);
      this.store.clearCooldown(cooldownBefore);
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
