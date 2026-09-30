import { selectBackfill } from "./backfill.js";
import type { Backfill, YoutubePlaylist } from "./playlists.js";
import type { InitialState, ListingEntry, YoutubeStore } from "./store.js";
import { isVideoId, playlistUrl, videoUrl } from "./urls.js";
import { errorSummary, runYtdlp } from "./ytdlp.js";

const LISTING_TIMEOUT_MS = 10 * 60_000;
// A flat listing of an 889-video playlist is 1.2 MB of JSON; 5,000 videos (YouTube's cap) stays well under this.
const LISTING_MAX_BYTES = 64 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 2 * 60_000;
const PLACEHOLDER_TITLE_RE = /^\[(private|deleted) video\]$/i;

export interface FlatListing {
  id: string;
  title: string;
  channel: string | null;
  availability: string | null;
  /** YouTube's own count, which includes private and deleted entries. */
  playlistCount: number | null;
  entries: ListingEntry[];
}

export interface SyncDeps {
  listPlaylist: (id: string) => Promise<FlatListing>;
  exactUploadDate: (videoId: string) => Promise<string | null>;
  /** Added dates from the Data API, or null without a key. May throw. */
  addedDates: (playlistId: string) => Promise<Map<string, string> | null>;
  now: () => Date;
}

export interface SyncResult {
  title: string;
  total: number;
  added: number;
  removed: number;
  restored: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function dateFromTimestamp(ts: unknown): string | null {
  const seconds = num(ts);
  return seconds === null ? null : new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** Parses `yt-dlp -J --flat-playlist` output. Entries without a valid video id are dropped. */
export function parseFlatListing(json: string): FlatListing {
  const data = JSON.parse(json) as Record<string, unknown>;
  const rawEntries = Array.isArray(data.entries) ? (data.entries as Record<string, unknown>[]) : [];
  const entries: ListingEntry[] = [];
  rawEntries.forEach((entry, index) => {
    const videoId = str(entry?.id);
    if (!videoId || !isVideoId(videoId)) return;
    const title = str(entry.title);
    entries.push({
      videoId,
      title: title && PLACEHOLDER_TITLE_RE.test(title) ? null : title,
      channel: str(entry.channel) ?? str(entry.uploader),
      durationS: num(entry.duration),
      publishedAt: dateFromTimestamp(entry.timestamp) ?? upload(entry.upload_date),
      position: index + 1,
    });
  });
  return {
    id: str(data.id) ?? "",
    title: str(data.title) ?? str(data.id) ?? "",
    channel: str(data.channel) ?? str(data.uploader),
    availability: str(data.availability),
    playlistCount: num(data.playlist_count),
    entries,
  };
}

function upload(value: unknown): string | null {
  const s = str(value);
  return s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

/** A private or deleted video: YouTube lists it with no title and no duration. */
export function isUnavailableEntry(entry: ListingEntry): boolean {
  return entry.title === null && entry.durationS === null;
}

export async function listPlaylistWithYtdlp(id: string): Promise<FlatListing> {
  const result = await runYtdlp(
    ["-J", "--flat-playlist", "--js-runtimes", "node", "--extractor-args", "youtubetab:approximate_date", "--", playlistUrl(id)],
    { timeoutMs: LISTING_TIMEOUT_MS, maxCaptureBytes: LISTING_MAX_BYTES },
  );
  if (result.timedOut) throw new Error("Listing the playlist timed out");
  if (result.code !== 0) throw new Error(errorSummary(result.stderr, result.code));
  return parseFlatListing(result.stdout);
}

export async function exactUploadDateWithYtdlp(videoId: string): Promise<string | null> {
  const result = await runYtdlp(
    ["--skip-download", "--no-playlist", "--js-runtimes", "node", "--print", "%(upload_date)s", "--", videoUrl(videoId)],
    { timeoutMs: METADATA_TIMEOUT_MS },
  );
  return result.code === 0 ? upload(result.stdout.trim()) : null;
}

/**
 * Lists the playlist and stores every entry. The first sync applies the
 * backfill filter; later syncs queue whatever is new. Records the outcome in
 * the sync state either way, then rethrows a failure.
 */
export async function syncPlaylist(store: YoutubeStore, playlist: YoutubePlaylist, deps: SyncDeps): Promise<SyncResult> {
  const now = deps.now().toISOString();
  try {
    const listing = await deps.listPlaylist(playlist.id);
    const state = store.getSyncState(playlist.id);
    const firstSync = !state.firstSyncAt;
    const known = store.knownMembers(playlist.id, listing.entries.map((e) => e.videoId));
    const unseen = listing.entries.filter((e) => !known.has(e.videoId));

    const wantsAddedDates = firstSync && playlist.backfill.kind === "added_since";
    const addedDates = wantsAddedDates || unseen.length > 0
      ? await deps.addedDates(playlist.id).catch((error) => {
        if (wantsAddedDates) throw error;
        return null;
      })
      : null;

    const available = listing.entries.filter((e) => !isUnavailableEntry(e));
    const selection = firstSync
      ? await selectBackfill(playlist.backfill, available, { exactUploadDate: deps.exactUploadDate, addedDates, today: now.slice(0, 10) })
      : null;

    const initialFor = (entry: ListingEntry): InitialState => {
      if (isUnavailableEntry(entry)) return { status: "unavailable" };
      if (selection && !selection.selected.has(entry.videoId)) return { status: "skipped", skipKind: "before_start" };
      return { status: playlist.mode === "auto" ? "queued" : "new" };
    };

    const counts = store.applyListing(
      playlist.id,
      listing.entries.map((entry) => ({
        ...entry,
        publishedAt: selection?.exactDates.get(entry.videoId) ?? entry.publishedAt,
        addedAt: addedDates?.get(entry.videoId) ?? null,
        initial: initialFor(entry),
      })),
      { complete: listing.entries.length > 0 && listing.entries.length === listing.playlistCount, now, resetUntouched: firstSync },
    );
    store.updateSyncState(playlist.id, {
      lastCheckedAt: now,
      lastError: null,
      count: listing.playlistCount,
      availability: listing.availability,
      firstSyncAt: state.firstSyncAt ?? now,
    });
    return { title: listing.title || playlist.title, total: listing.entries.length, ...counts };
  } catch (error) {
    store.updateSyncState(playlist.id, { lastCheckedAt: now, lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export interface BackfillChange {
  kept: number;
  released: number;
  skipped: number;
}

/**
 * Re-runs a new backfill choice over the videos the first sync found. Only
 * videos that are still waiting or were left out by the filter move; the
 * user's own skips and picks and anything further along stay where they are.
 */
export async function changeBackfill(
  store: YoutubeStore,
  playlist: YoutubePlaylist,
  backfill: Backfill,
  deps: Pick<SyncDeps, "exactUploadDate" | "addedDates" | "now">,
): Promise<BackfillChange> {
  const now = deps.now().toISOString();
  const { firstSyncAt } = store.getSyncState(playlist.id);
  if (!firstSyncAt) throw new Error("The playlist has not been checked yet");

  const candidates = store
    .playlistVideos(playlist.id)
    .filter((v) => v.playlist_id === playlist.id && v.first_seen_at <= firstSyncAt && !v.removed_at && !v.user_queued_at)
    .filter((v) => v.status === "new" || v.status === "queued" || (v.status === "skipped" && v.skip_kind === "before_start"));

  const addedDates = backfill.kind === "added_since" ? await deps.addedDates(playlist.id) : null;
  const { selected } = await selectBackfill(
    backfill,
    candidates.map((v) => ({ videoId: v.video_id, publishedAt: v.published_at })),
    { exactUploadDate: deps.exactUploadDate, addedDates, today: now.slice(0, 10) },
  );

  // A released video goes where a newly listed one would: straight to the lane, or to the user on a manual playlist.
  const releaseTo = playlist.mode === "auto" ? "queued" : "new";
  const result: BackfillChange = { kept: 0, released: 0, skipped: 0 };
  for (const video of candidates) {
    const keep = selected.has(video.video_id);
    if (keep && video.status === "skipped") {
      store.setStatus(video.video_id, releaseTo, { now });
      result.released += 1;
    } else if (!keep && video.status !== "skipped") {
      store.setStatus(video.video_id, "skipped", { skipKind: "before_start", now });
      result.skipped += 1;
    } else if (keep) {
      result.kept += 1;
    }
  }
  return result;
}
