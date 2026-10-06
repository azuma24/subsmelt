import type { Express, Response } from "express";
import { getSetting } from "../config.js";
import { REDACTED_SECRET } from "../connections.js";
import { countPendingJobs } from "../db.js";
import { currentTranslationGate, gpuShared } from "../gpu-gate.js";
import { logger } from "../logger.js";
import { broadcast } from "../sse.js";
import { fetchAddedDates, testApiKey } from "../youtube/data-api.js";
import {
  defaultPlaylistFields,
  findPlaylist,
  folderFromTitle,
  parseBackfill,
  parsePlaylistFields,
  readPlaylists,
  removePlaylist,
  savePlaylist,
  type YoutubePlaylist,
} from "../youtube/playlists.js";
import { exportNoteForVideo, NoteExportError, notesFolderStatus, type NoteExportFailure } from "../youtube/note-export.js";
import { cookiesStatus, parseCookies, removeCookies, saveCookies } from "../youtube/cookies.js";
import { IllegalTransitionError, type YoutubeStore } from "../youtube/store.js";
import { changeBackfill, changeChannelContent, isUnavailableEntry, listFollowedWithYtdlp, listingTitle, resolveChannelWithYtdlp } from "../youtube/sync.js";
import { isChannelUploads, isPlaylistId, isVideoId, parseChannelInput, parsePlaylistInput } from "../youtube/urls.js";
import type { UserAction } from "../youtube/video-status.js";
import type { YoutubePipeline, YoutubePlaylistSummary, YoutubeStatus } from "../../shared/youtube.js";
import { isQueueRunning } from "../queue.js";
import { CooldownError, nextCheckAt, transcriptionReady, type YoutubeWorker } from "../youtube/worker.js";
import { ffmpegVersion, resolveYtdlpBin, updateYtdlp, ytdlpVersion } from "../youtube/ytdlp.js";
import { errorMessage } from "../errors.js";

const message = (error: unknown) => (error instanceof Error ? errorMessage(error) : String(error));
// A day ahead of UTC, so a user east of Greenwich can pick the month that has already started for them.
const today = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const NO_KEY_ERROR = "Added since needs a YouTube Data API key in Settings";

const NOTE_ERROR_STATUS: Record<NoteExportFailure, number> = { unknown_video: 404, no_media: 409, no_transcript: 409, notes_folder: 503 };

export async function youtubeStatus(worker?: YoutubeWorker): Promise<YoutubeStatus> {
  const [ytdlp, ffmpeg] = await Promise.all([ytdlpVersion(), ffmpegVersion()]);
  const cooldown = worker?.activeCooldown() ?? null;
  return {
    ytdlp: { available: ytdlp !== null, version: ytdlp, path: resolveYtdlpBin() },
    ffmpeg: { available: ffmpeg !== null, version: ffmpeg },
    apiKey: Boolean(getSetting("youtube_api_key")),
    notes: notesFolderStatus(),
    cookies: cookiesStatus(),
    cooldown: cooldown && { until: cooldown.until, cause: cooldown.cause },
  };
}

/** What holds the subtitle and translation steps back: the shared GPU, or no transcription backend. */
export function pipelineStatus(store: YoutubeStore): YoutubePipeline {
  const gate = currentTranslationGate();
  const ready = transcriptionReady();
  return {
    gpu: {
      shared: gpuShared(),
      held: !gate.open && countPendingJobs() > 0,
      waitingFor: gate.open ? 0 : gate.waitingFor,
      translationRunning: isQueueRunning(),
    },
    transcription: { ready, waiting: ready ? 0 : store.statusTotals().transcribing ?? 0 },
  };
}

function playlistSummary(store: YoutubeStore, worker: YoutubeWorker, playlist: YoutubePlaylist): YoutubePlaylistSummary {
  const { firstSyncAt: _firstSyncAt, ...sync } = store.getSyncState(playlist.id);
  return {
    ...playlist,
    sync: { ...sync, checking: worker.isChecking(playlist.id), nextCheckAt: nextCheckAt(playlist, sync.lastCheckedAt) },
    counts: store.counts(playlist.id),
  };
}

// A cooldown refusal is the server asking the client to wait, not a YouTube failure.
const laneErrorStatus = (error: unknown, fallback: number) => (error instanceof CooldownError ? 503 : fallback);

const USER_ACTION_NAMES: readonly UserAction[] = ["download", "retry", "skip"];
// One page of the list is 200 rows; a pick can span a few pages.
const MAX_PICKED_VIDEOS = 1000;

function withPlaylist(res: Response, id: string): YoutubePlaylist | null {
  const playlist = isPlaylistId(id) ? findPlaylist(id) : undefined;
  if (!playlist) {
    res.status(404).json({ error: "This playlist is not followed" });
    return null;
  }
  return playlist;
}

export function registerYoutubeRoutes(app: Express, store: YoutubeStore, worker: YoutubeWorker): void {
  app.get("/api/youtube/pipeline", (_req, res) => {
    res.json(pipelineStatus(store));
  });

  app.get("/api/youtube/status", async (_req, res) => {
    res.json(await youtubeStatus(worker));
  });

  app.put("/api/youtube/cookies", (req, res) => {
    const cookies = parseCookies(req.body?.content);
    if (!cookies.ok) return res.status(400).json({ error: cookies.error });
    const status = saveCookies(cookies.value);
    logger.info("youtube", "Cookies uploaded");
    res.json(status);
  });

  app.delete("/api/youtube/cookies", (_req, res) => {
    removeCookies();
    logger.info("youtube", "Cookies removed");
    res.json(cookiesStatus());
  });

  // The Settings field checks the folder as it is typed, before it is saved.
  app.get("/api/youtube/notes-folder", (req, res) => {
    const dir = typeof req.query.path === "string" && req.query.path.trim() ? req.query.path.trim() : getSetting("youtube_notes_dir");
    res.json(notesFolderStatus(dir));
  });

  app.post("/api/youtube/videos/:videoId/note", async (req, res) => {
    const { videoId } = req.params;
    if (!isVideoId(videoId) || !store.getVideo(videoId)) return res.status(404).json({ error: "Unknown video" });
    try {
      const { file: _file, ...payload } = await exportNoteForVideo({ store }, videoId);
      res.json(payload);
    } catch (error) {
      const status = error instanceof NoteExportError ? NOTE_ERROR_STATUS[error.kind] : 500;
      if (status === 500) logger.error("youtube", `Writing the note of ${videoId} failed: ${message(error)}`);
      res.status(status).json({ error: message(error) });
    }
  });

  app.post("/api/youtube/videos/:videoId/:action", (req, res) => {
    const { videoId, action } = req.params;
    if (!USER_ACTION_NAMES.includes(action as UserAction)) return res.status(404).json({ error: "Unknown action" });
    if (!isVideoId(videoId) || !store.getVideo(videoId)) return res.status(404).json({ error: "Unknown video" });
    try {
      const row = store.applyUserAction(videoId, action as UserAction, new Date().toISOString());
      broadcast("youtube:video", { videoId, playlistId: row.playlist_id, status: row.status });
      worker.kick();
      res.json(row);
    } catch (error) {
      if (error instanceof IllegalTransitionError) return res.status(409).json({ error: message(error) });
      throw error;
    }
  });

  app.post("/api/youtube/ytdlp/update", async (_req, res) => {
    try {
      const result = await updateYtdlp();
      logger.info("youtube", `yt-dlp updated: ${result.version ?? "unknown version"} at ${result.path}`);
      res.json(result);
    } catch (error) {
      logger.error("youtube", `yt-dlp update failed: ${message(error)}`);
      res.status(500).json({ error: message(error) });
    }
  });

  app.post("/api/youtube/api-key/test", async (req, res) => {
    const typed = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    const key = typed && typed !== REDACTED_SECRET ? typed : getSetting("youtube_api_key");
    if (!key) return res.status(400).json({ error: "No API key to test" });
    try {
      await testApiKey(key);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  app.get("/api/youtube/playlists", (_req, res) => {
    res.json({ playlists: readPlaylists().map((p) => playlistSummary(store, worker, p)) });
  });

  // A channel is followed as its uploads playlist, so both kinds share the rest of the pipeline.
  app.post("/api/youtube/playlists/preview", async (req, res) => {
    const pasted = typeof req.body?.url === "string" ? req.body.url : "";
    const isChannel = req.body?.kind === "channel";
    const channel = isChannel ? parseChannelInput(pasted) : null;
    const playlistId = isChannel ? null : parsePlaylistInput(pasted);
    if (isChannel && !channel) return res.status(400).json({ error: "Paste a link to a YouTube channel" });
    if (!isChannel && !playlistId) return res.status(400).json({ error: "Paste a link to a YouTube playlist" });
    let id: string;
    let listing;
    try {
      id = channel ? await worker.metadataCall(() => resolveChannelWithYtdlp(channel)) : playlistId!;
      listing = await worker.metadataCall(() => listFollowedWithYtdlp(id));
    } catch (error) {
      return res.status(laneErrorStatus(error, 502)).json({ error: message(error) });
    }
    const title = listingTitle(listing);
    const key = getSetting("youtube_api_key");
    let addedDates: Map<string, string> | null = null;
    let addedDatesError: string | null = null;
    if (key && !isChannelUploads(id)) {
      try {
        addedDates = await fetchAddedDates(id, key);
      } catch (error) {
        addedDatesError = message(error);
      }
    }
    const available = listing.entries.filter((e) => !isUnavailableEntry(e));
    res.json({
      id,
      title,
      channel: listing.channel,
      availability: listing.availability,
      count: listing.playlistCount ?? listing.entries.length,
      unavailable: listing.entries.length - available.length,
      followed: Boolean(findPlaylist(id)),
      folder: folderFromTitle(title, id),
      addedDates: addedDates !== null,
      addedDatesError,
      entries: available.map((e) => ({ posted: e.publishedAt, added: addedDates?.get(e.videoId) ?? null, durationS: e.durationS, kind: e.contentKind ?? null })),
    });
  });

  app.post("/api/youtube/playlists", (req, res) => {
    const body = req.body ?? {};
    const id = typeof body.url === "string" ? parsePlaylistInput(body.url) : null;
    if (!id) return res.status(400).json({ error: "Paste a link to a YouTube playlist" });
    if (findPlaylist(id)) return res.status(409).json({ error: "This playlist is already followed" });
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : id;
    const fields = parsePlaylistFields(body, defaultPlaylistFields(folderFromTitle(title, id)), today());
    if (!fields.ok) return res.status(400).json({ error: fields.error });
    if (fields.value.backfill.kind === "added_since" && !getSetting("youtube_api_key")) return res.status(400).json({ error: NO_KEY_ERROR });

    const playlist: YoutubePlaylist = { id, title, ...fields.value };
    store.deleteSyncState(id);
    savePlaylist(playlist);
    logger.info("youtube", `Followed ${isChannelUploads(id) ? "channel" : "playlist"} ${title} (${id})`);
    worker.checkPlaylist(playlist, { asNewFollow: true }).catch(() => undefined);
    res.status(201).json(playlistSummary(store, worker, playlist));
  });

  app.put("/api/youtube/playlists/:id", async (req, res) => {
    const playlist = withPlaylist(res, req.params.id);
    if (!playlist) return;
    // The backfill only changes through its own route, which re-applies it.
    const { backfill: _backfill, ...body } = req.body ?? {};
    const { id: _id, title: _title, ...current } = playlist;
    const fields = parsePlaylistFields(body, current, today());
    if (!fields.ok) return res.status(400).json({ error: fields.error });
    const updated: YoutubePlaylist = { ...playlist, ...fields.value };
    // Saved before the rows change, so a check finishing meanwhile applies the new choice;
    // rows it stored under the old one are already listed when the change skips them.
    savePlaylist(updated);
    if (isChannelUploads(playlist.id) && JSON.stringify(updated.include) !== JSON.stringify(playlist.include)) {
      try {
        const change = await changeChannelContent(store, updated, updated.include, worker.syncDeps());
        logger.info("youtube", `Changed Shorts and live of ${playlist.title}: ${change.released} released, ${change.skipped} skipped`);
        worker.kick();
      } catch (error) {
        const current = findPlaylist(playlist.id);
        if (current) savePlaylist({ ...current, include: playlist.include });
        return res.status(laneErrorStatus(error, 400)).json({ error: message(error) });
      }
    }
    broadcast("youtube:playlist", { playlistId: playlist.id });
    res.json(playlistSummary(store, worker, updated));
  });

  app.delete("/api/youtube/playlists/:id", (req, res) => {
    const playlist = withPlaylist(res, req.params.id);
    if (!playlist) return;
    removePlaylist(playlist.id);
    store.deleteSyncState(playlist.id);
    logger.info("youtube", `Unfollowed playlist ${playlist.title} (${playlist.id}); files and video records kept`);
    broadcast("youtube:playlist", { playlistId: playlist.id });
    res.json({ ok: true });
  });

  app.post("/api/youtube/playlists/:id/sync", async (req, res) => {
    const playlist = withPlaylist(res, req.params.id);
    if (!playlist) return;
    try {
      res.json({ ok: true, ...(await worker.checkPlaylist(playlist)) });
    } catch (error) {
      res.status(laneErrorStatus(error, 502)).json({ error: message(error) });
    }
  });

  app.post("/api/youtube/playlists/:id/backfill", async (req, res) => {
    const playlist = withPlaylist(res, req.params.id);
    if (!playlist) return;
    const backfill = parseBackfill(req.body?.backfill, today());
    if (!backfill.ok) return res.status(400).json({ error: backfill.error });
    if (backfill.value.kind === "added_since" && !getSetting("youtube_api_key")) return res.status(400).json({ error: NO_KEY_ERROR });
    try {
      const change = await changeBackfill(store, playlist, backfill.value, worker.syncDeps());
      const current = findPlaylist(playlist.id);
      if (current) savePlaylist({ ...current, backfill: backfill.value });
      logger.info("youtube", `Changed backfill of ${playlist.title}: ${change.released} released, ${change.skipped} skipped`);
      broadcast("youtube:playlist", { playlistId: playlist.id });
      worker.kick();
      res.json({ ok: true, ...change });
    } catch (error) {
      res.status(laneErrorStatus(error, 400)).json({ error: message(error) });
    }
  });

  // Picked from the list: the videos a backfill left out, chosen one by one.
  app.post("/api/youtube/playlists/:id/videos/download", (req, res) => {
    const playlist = withPlaylist(res, req.params.id);
    if (!playlist) return;
    const ids: unknown = req.body?.videoIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PICKED_VIDEOS || !ids.every((id) => typeof id === "string")) {
      return res.status(400).json({ error: `videoIds must list 1 to ${MAX_PICKED_VIDEOS} video ids` });
    }
    const now = new Date().toISOString();
    let downloaded = 0;
    for (const videoId of new Set(ids as string[])) {
      const video = isVideoId(videoId) ? store.getVideo(videoId) : undefined;
      if (!video || video.playlist_id !== playlist.id) continue;
      try {
        store.applyUserAction(videoId, "download", now);
        downloaded += 1;
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
      }
    }
    if (downloaded > 0) {
      logger.info("youtube", `Queued ${downloaded} picked videos of ${playlist.title}`);
      broadcast("youtube:playlist", { playlistId: playlist.id });
      worker.kick();
    }
    res.json({ downloaded, refused: new Set(ids as string[]).size - downloaded });
  });

  app.get("/api/youtube/playlists/:id/videos", (req, res) => {
    const playlist = withPlaylist(res, req.params.id);
    if (!playlist) return;
    const videos = store.playlistVideos(playlist.id).map(({ subtitle_plan, ...video }) => {
      const pct = video.status === "downloading" || video.status === "transcribing" ? worker.progressOf(video.video_id) : undefined;
      const subtitles = subtitle_plan ? JSON.parse(subtitle_plan) : null;
      return pct === undefined ? { ...video, subtitles } : { ...video, subtitles, pct };
    });
    res.json({ videos });
  });
}
