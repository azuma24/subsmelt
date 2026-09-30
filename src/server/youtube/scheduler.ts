import { getSetting } from "../config.js";
import { logger } from "../logger.js";
import { broadcast } from "../sse.js";
import { fetchAddedDates } from "./data-api.js";
import { findPlaylist, readPlaylists, savePlaylist, type YoutubePlaylist } from "./playlists.js";
import type { YoutubeStore } from "./store.js";
import { exactUploadDateWithYtdlp, listPlaylistWithYtdlp, syncPlaylist, type SyncDeps, type SyncResult } from "./sync.js";

const TICK_MS = 60_000;

let lane: Promise<unknown> = Promise.resolve();

/**
 * Every yt-dlp call that reaches YouTube runs here, one at a time, so a
 * playlist check, a preview and a date lookup never hit YouTube together.
 */
export function onYoutubeLane<T>(task: () => Promise<T>): Promise<T> {
  const run = lane.then(task, task);
  lane = run.catch(() => undefined);
  return run;
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

const inFlight = new Map<string, Promise<SyncResult>>();

export function isSyncing(playlistId: string): boolean {
  return inFlight.has(playlistId);
}

async function syncAndAnnounce(store: YoutubeStore, playlist: YoutubePlaylist): Promise<SyncResult> {
  broadcast("youtube:playlist", { playlistId: playlist.id, checking: true });
  try {
    const result = await onYoutubeLane(() => syncPlaylist(store, playlist, liveSyncDeps()));
    const current = findPlaylist(playlist.id);
    if (current && result.title && current.title !== result.title) savePlaylist({ ...current, title: result.title });
    const { lastCheckedAt } = store.getSyncState(playlist.id);
    logger.info("youtube", `Checked playlist ${result.title}: ${result.total} listed, ${result.added} new, ${result.removed} removed`);
    broadcast("youtube:playlist", { playlistId: playlist.id, lastCheckedAt });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("youtube", `Checking playlist ${playlist.title} failed: ${message}`);
    broadcast("youtube:playlist", { playlistId: playlist.id, lastCheckedAt: store.getSyncState(playlist.id).lastCheckedAt, error: message });
    throw error;
  }
}

/** Starts a check of one playlist, or joins the one already running. */
export function checkPlaylist(store: YoutubeStore, playlist: YoutubePlaylist): Promise<SyncResult> {
  const running = inFlight.get(playlist.id);
  if (running) return running;
  const run = syncAndAnnounce(store, playlist).finally(() => inFlight.delete(playlist.id));
  inFlight.set(playlist.id, run);
  return run;
}

export function nextCheckAt(playlist: YoutubePlaylist, lastCheckedAt: string | null): string | null {
  if (!playlist.enabled) return null;
  if (!lastCheckedAt) return new Date(0).toISOString();
  return new Date(Date.parse(lastCheckedAt) + playlist.checkEveryMinutes * 60_000).toISOString();
}

function checkDuePlaylists(store: YoutubeStore): void {
  const now = Date.now();
  for (const playlist of readPlaylists()) {
    const due = nextCheckAt(playlist, store.getSyncState(playlist.id).lastCheckedAt);
    if (due && Date.parse(due) <= now) checkPlaylist(store, playlist).catch(() => undefined);
  }
}

export function startYoutubeScheduler(store: YoutubeStore): () => void {
  checkDuePlaylists(store);
  const timer = setInterval(() => checkDuePlaylists(store), TICK_MS);
  return () => clearInterval(timer);
}
