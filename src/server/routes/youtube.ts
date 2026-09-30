import fs from "node:fs";
import type { Express, Response } from "express";
import { getSetting } from "../config.js";
import { REDACTED_SECRET } from "../connections.js";
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
import { checkPlaylist, isSyncing, liveSyncDeps, nextCheckAt, onYoutubeLane } from "../youtube/scheduler.js";
import type { YoutubeStore } from "../youtube/store.js";
import { changeBackfill, isUnavailableEntry, listPlaylistWithYtdlp } from "../youtube/sync.js";
import { isPlaylistId, parsePlaylistInput } from "../youtube/urls.js";
import { ffmpegVersion, resolveYtdlpBin, updateYtdlp, ytdlpVersion } from "../youtube/ytdlp.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const today = () => new Date().toISOString().slice(0, 10);
const NO_KEY_ERROR = "Added since needs a YouTube Data API key in Settings";

function notesFolderStatus() {
  const dir = getSetting("youtube_notes_dir");
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return { path: dir, writable: fs.statSync(dir).isDirectory() };
  } catch {
    return { path: dir, writable: false };
  }
}

export async function youtubeStatus() {
  const [ytdlp, ffmpeg] = await Promise.all([ytdlpVersion(), ffmpegVersion()]);
  return {
    ytdlp: { available: ytdlp !== null, version: ytdlp, path: resolveYtdlpBin() },
    ffmpeg: { available: ffmpeg !== null, version: ffmpeg },
    apiKey: Boolean(getSetting("youtube_api_key")),
    notes: notesFolderStatus(),
  };
}

function playlistSummary(store: YoutubeStore, playlist: YoutubePlaylist) {
  const { firstSyncAt: _firstSyncAt, ...sync } = store.getSyncState(playlist.id);
  return {
    ...playlist,
    sync: { ...sync, checking: isSyncing(playlist.id), nextCheckAt: nextCheckAt(playlist, sync.lastCheckedAt) },
    counts: store.counts(playlist.id),
  };
}

function withPlaylist(res: Response, id: string): YoutubePlaylist | null {
  const playlist = isPlaylistId(id) ? findPlaylist(id) : undefined;
  if (!playlist) {
    res.status(404).json({ error: "This playlist is not followed" });
    return null;
  }
  return playlist;
}

export function registerYoutubeRoutes(app: Express, store: YoutubeStore): void {
  app.get("/api/youtube/status", async (_req, res) => {
    res.json(await youtubeStatus());
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
    res.json({ playlists: readPlaylists().map((p) => playlistSummary(store, p)) });
  });

  app.post("/api/youtube/playlists/preview", async (req, res) => {
    const id = typeof req.body?.url === "string" ? parsePlaylistInput(req.body.url) : null;
    if (!id) return res.status(400).json({ error: "Paste a link to a YouTube playlist" });
    let listing;
    try {
      listing = await onYoutubeLane(() => listPlaylistWithYtdlp(id));
    } catch (error) {
      return res.status(502).json({ error: message(error) });
    }
    const key = getSetting("youtube_api_key");
    let addedDates: Map<string, string> | null = null;
    let addedDatesError: string | null = null;
    if (key) {
      try {
        addedDates = await fetchAddedDates(id, key);
      } catch (error) {
        addedDatesError = message(error);
      }
    }
    const available = listing.entries.filter((e) => !isUnavailableEntry(e));
    res.json({
      id,
      title: listing.title,
      channel: listing.channel,
      availability: listing.availability,
      count: listing.playlistCount ?? listing.entries.length,
      unavailable: listing.entries.length - available.length,
      followed: Boolean(findPlaylist(id)),
      folder: folderFromTitle(listing.title, id),
      addedDates: addedDates !== null,
      addedDatesError,
      entries: available.map((e) => ({ posted: e.publishedAt, added: addedDates?.get(e.videoId) ?? null, durationS: e.durationS })),
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
    logger.info("youtube", `Followed playlist ${title} (${id})`);
    checkPlaylist(store, playlist).catch(() => undefined);
    res.status(201).json(playlistSummary(store, playlist));
  });

  app.put("/api/youtube/playlists/:id", (req, res) => {
    const playlist = withPlaylist(res, req.params.id);
    if (!playlist) return;
    // The backfill only changes through its own route, which re-applies it.
    const { backfill: _backfill, ...body } = req.body ?? {};
    const { id: _id, title: _title, ...current } = playlist;
    const fields = parsePlaylistFields(body, current, today());
    if (!fields.ok) return res.status(400).json({ error: fields.error });
    const updated: YoutubePlaylist = { ...playlist, ...fields.value };
    savePlaylist(updated);
    broadcast("youtube:playlist", { playlistId: playlist.id });
    res.json(playlistSummary(store, updated));
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
      res.json({ ok: true, ...(await checkPlaylist(store, playlist)) });
    } catch (error) {
      res.status(502).json({ error: message(error) });
    }
  });

  app.post("/api/youtube/playlists/:id/backfill", async (req, res) => {
    const playlist = withPlaylist(res, req.params.id);
    if (!playlist) return;
    const backfill = parseBackfill(req.body?.backfill, today());
    if (!backfill.ok) return res.status(400).json({ error: backfill.error });
    if (backfill.value.kind === "added_since" && !getSetting("youtube_api_key")) return res.status(400).json({ error: NO_KEY_ERROR });
    try {
      const change = await onYoutubeLane(() => changeBackfill(store, playlist, backfill.value, liveSyncDeps()));
      savePlaylist({ ...(findPlaylist(playlist.id) ?? playlist), backfill: backfill.value });
      logger.info("youtube", `Changed backfill of ${playlist.title}: ${change.released} released, ${change.skipped} skipped`);
      broadcast("youtube:playlist", { playlistId: playlist.id });
      res.json({ ok: true, ...change });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  app.get("/api/youtube/playlists/:id/videos", (req, res) => {
    const playlist = withPlaylist(res, req.params.id);
    if (!playlist) return;
    res.json({ videos: store.playlistVideos(playlist.id) });
  });
}
