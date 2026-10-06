import { selectBackfill } from "./backfill.js";
import { withCookieArgs } from "./cookies.js";
import type { Backfill, ChannelInclude, YoutubePlaylist } from "./playlists.js";
import type { ContentKind, InitialState, ListingEntry, VideoRow, YoutubeStore } from "./store.js";
import { channelContentLists, isChannelId, isChannelUploads, isVideoId, playlistUrl, uploadsPlaylistId, videoUrl, type ChannelInput } from "./urls.js";
import { classifyYtdlpError, errorSummary, runYtdlp } from "./ytdlp.js";
import { errorMessage } from "../errors.js";

const LISTING_TIMEOUT_MS = 10 * 60_000;
// A flat listing of an 889-video playlist is 1.2 MB of JSON; 5,000 videos (YouTube's playlist cap) stays well
// under this, and so does a channel's uploads playlist, which has no cap, into the tens of thousands.
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

/** A channel's uploads playlist is titled "Uploads from <channel>"; the channel's own name reads better. */
export function listingTitle(listing: FlatListing): string {
  return isChannelUploads(listing.id) && listing.channel ? listing.channel : listing.title;
}

export interface SyncDeps {
  listPlaylist: (id: string) => Promise<FlatListing>;
  exactUploadDate: (videoId: string) => Promise<string | null>;
  /** Added dates from the Data API, or null without a key. May throw. */
  addedDates: (playlistId: string) => Promise<Map<string, string> | null>;
  /** Whether a playlist is still followed; videos of an unfollowed owner pass to the playlist listing them. */
  isFollowed?: (playlistId: string) => boolean;
  /**
   * The follow as saved now. A sync applies its listing with these settings,
   * so a Shorts or mode change saved while the listing ran is not undone.
   */
  currentPlaylist?: (playlistId: string) => YoutubePlaylist | undefined;
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

export async function listPlaylistWithYtdlp(id: string, { maxBytes = LISTING_MAX_BYTES } = {}): Promise<FlatListing> {
  const result = await withCookieArgs((cookies) => runYtdlp(
    ["-J", "--flat-playlist", "--js-runtimes", "node", "--extractor-args", "youtubetab:approximate_date", ...cookies, "--", playlistUrl(id)],
    { timeoutMs: LISTING_TIMEOUT_MS, maxCaptureBytes: maxBytes },
  ));
  if (result.timedOut) throw new Error("Listing the playlist timed out");
  if (result.code !== 0) throw new Error(errorSummary(result.stderr, result.code));
  if (result.stdoutTruncated) throw new Error(`The playlist listing is larger than ${maxBytes} bytes`);
  return parseFlatListing(result.stdout);
}

const MISSING_LIST_RE = /playlist does not exist/i;
const CONTENT_KINDS: ContentKind[] = ["video", "short", "live"];

/**
 * A channel's uploads, listed as its videos, Shorts and live streams so each
 * entry carries its kind. A channel without Shorts or live streams has no such
 * list, which YouTube reports as missing; that counts as empty.
 */
export async function listChannelUploads(
  uploadsId: string,
  listOne: (id: string) => Promise<FlatListing> = listPlaylistWithYtdlp,
): Promise<FlatListing> {
  const ids = channelContentLists(uploadsId);
  const parts: { kind: ContentKind; listing: FlatListing | null }[] = [];
  for (const kind of CONTENT_KINDS) {
    try {
      parts.push({ kind, listing: await listOne(ids[kind]) });
    } catch (error) {
      if (!(error instanceof Error && MISSING_LIST_RE.test(errorMessage(error)))) throw error;
      parts.push({ kind, listing: null });
    }
  }
  const seen = new Set<string>();
  const entries = parts
    .flatMap(({ kind, listing }) => (listing?.entries ?? []).map((entry) => ({ ...entry, contentKind: kind })))
    .filter((entry) => !seen.has(entry.videoId) && Boolean(seen.add(entry.videoId)))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .map((entry, index) => ({ ...entry, position: index + 1 }));
  const found = parts.map((p) => p.listing).filter((l): l is FlatListing => l !== null);
  const counts = parts.map((p) => (p.listing ? p.listing.playlistCount : 0));
  return {
    id: uploadsId,
    title: found[0]?.title ?? uploadsId,
    channel: found.find((l) => l.channel)?.channel ?? null,
    availability: found[0]?.availability ?? null,
    playlistCount: counts.every((c) => c !== null) ? counts.reduce((sum, c) => sum! + c!, 0) : null,
    entries,
  };
}

/** Lists what a follow covers: a playlist as it is, a channel by kind. */
export function listFollowedWithYtdlp(id: string): Promise<FlatListing> {
  return isChannelUploads(id) ? listChannelUploads(id) : listPlaylistWithYtdlp(id);
}

/** Whether a follow keeps an entry of this kind. Playlist entries have no kind and are always kept. */
export function includesContent(include: ChannelInclude, kind: ContentKind | null | undefined): boolean {
  if (kind === "short") return include.shorts;
  if (kind === "live") return include.live;
  return true;
}

/** The uploads playlist of a pasted channel. A handle or legacy name costs one yt-dlp call to resolve. */
export async function resolveChannelWithYtdlp(input: ChannelInput): Promise<string> {
  if ("channelId" in input) return uploadsPlaylistId(input.channelId);
  const result = await withCookieArgs((cookies) => runYtdlp(
    ["-J", "--flat-playlist", "--playlist-items", "1", "--js-runtimes", "node", ...cookies, "--", input.url],
    { timeoutMs: METADATA_TIMEOUT_MS },
  ));
  if (result.timedOut) throw new Error("Looking up the channel timed out");
  if (result.code !== 0) throw new Error(errorSummary(result.stderr, result.code));
  let channelId: unknown;
  try {
    channelId = (JSON.parse(result.stdout) as { channel_id?: unknown }).channel_id;
  } catch {
    channelId = null;
  }
  if (typeof channelId !== "string" || !isChannelId(channelId)) throw new Error("YouTube did not return a channel for this link");
  return uploadsPlaylistId(channelId);
}

export async function exactUploadDateWithYtdlp(videoId: string): Promise<string | null> {
  const result = await withCookieArgs((cookies) => runYtdlp(
    ["--skip-download", "--no-playlist", "--js-runtimes", "node", "--print", "%(upload_date)s", ...cookies, "--", videoUrl(videoId)],
    { timeoutMs: METADATA_TIMEOUT_MS },
  ));
  if (result.code === 0) return upload(result.stdout.trim());
  // YouTube pushing back must reach the lane's cooldown; any other failure just leaves the date unknown.
  const cls = classifyYtdlpError(result.stderr);
  if (cls === "rate_limited" || cls === "bot_check") throw new Error(errorSummary(result.stderr, result.code));
  return null;
}

/** Looks each exact date up once: every date found is stored at once, so a lookup cut short resumes. */
function rememberedExactDates(store: YoutubeStore, lookup: SyncDeps["exactUploadDate"]): SyncDeps["exactUploadDate"] {
  return async (videoId) => {
    const known = store.exactDate(videoId);
    if (known) return known;
    const date = await lookup(videoId);
    if (date) store.saveExactDate(videoId, date);
    return date;
  };
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

    // A channel's added date is its upload date; scanning the uploads for it would cost a request per 50 videos.
    const wantsAddedDates = firstSync && playlist.backfill.kind === "added_since";
    const addedDates = !isChannelUploads(playlist.id) && (wantsAddedDates || unseen.length > 0)
      ? await deps.addedDates(playlist.id).catch((error) => {
        if (wantsAddedDates) throw error;
        return null;
      })
      : null;

    // Kinds the follow leaves out are skipped whatever their date, so they cost no lookup.
    const candidates = listing.entries.filter((e) => !isUnavailableEntry(e) && includesContent(playlist.include, e.contentKind));
    const exactUploadDate = rememberedExactDates(store, deps.exactUploadDate);
    const selection = firstSync
      ? await selectBackfill(playlist.backfill, candidates, { exactUploadDate, addedDates, today: now.slice(0, 10) })
      : null;

    // Read after every await: from here to the store write nothing else runs.
    const settings = deps.currentPlaylist?.(playlist.id) ?? playlist;
    const initialFor = (entry: ListingEntry): InitialState => {
      if (isUnavailableEntry(entry)) return { status: "unavailable" };
      if (!includesContent(settings.include, entry.contentKind)) return { status: "skipped", skipKind: "content" };
      if (selection && !selection.selected.has(entry.videoId)) return { status: "skipped", skipKind: "before_start" };
      return { status: settings.mode === "auto" ? "queued" : "new" };
    };

    const counts = store.applyListing(
      playlist.id,
      listing.entries.map((entry) => ({
        ...entry,
        publishedAt: selection?.exactDates.get(entry.videoId) ?? entry.publishedAt,
        addedAt: addedDates?.get(entry.videoId) ?? null,
        initial: initialFor(entry),
      })),
      { complete: listing.entries.length > 0 && listing.entries.length === listing.playlistCount, now, resetUntouched: firstSync, isFollowed: deps.isFollowed },
    );
    store.updateSyncState(playlist.id, {
      lastCheckedAt: now,
      lastError: null,
      count: listing.playlistCount,
      availability: listing.availability,
      firstSyncAt: state.firstSyncAt ?? now,
    });
    return { title: listingTitle(listing) || playlist.title, total: listing.entries.length, ...counts };
  } catch (error) {
    store.updateSyncState(playlist.id, { lastCheckedAt: now, lastError: error instanceof Error ? errorMessage(error) : String(error) });
    throw error;
  }
}

/** Whether a video still has the status and pick it had when a filter change read it. */
function unchanged(store: YoutubeStore, video: VideoRow): boolean {
  const current = store.getVideo(video.video_id);
  return current?.status === video.status && current.user_queued_at === video.user_queued_at;
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
    { exactUploadDate: rememberedExactDates(store, deps.exactUploadDate), addedDates, today: now.slice(0, 10) },
  );

  // A released video goes where a newly listed one would: straight to the lane, or to the user on a manual playlist.
  const releaseTo = playlist.mode === "auto" ? "queued" : "new";
  const result: BackfillChange = { kept: 0, released: 0, skipped: 0 };
  for (const video of candidates) {
    // The lookups let the download lane run meanwhile: a video it took is no longer the filter's to move.
    if (!unchanged(store, video)) continue;
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

export interface ContentChange {
  released: number;
  skipped: number;
}

/**
 * Applies a channel's new Shorts and live choice to the videos already
 * listed. A kind turned off skips its untouched videos. A kind turned on goes
 * through the backfill the way the first sync would have taken it, so turning
 * Shorts on never queues years of old Shorts unless the backfill asks for them.
 */
export async function changeChannelContent(
  store: YoutubeStore,
  playlist: YoutubePlaylist,
  include: ChannelInclude,
  deps: Pick<SyncDeps, "exactUploadDate" | "addedDates" | "now">,
): Promise<ContentChange> {
  const now = deps.now().toISOString();
  const { firstSyncAt } = store.getSyncState(playlist.id);
  const result: ContentChange = { released: 0, skipped: 0 };
  if (!firstSyncAt) return result;

  const listed = store.playlistVideos(playlist.id).filter((v) => v.playlist_id === playlist.id && !v.removed_at && !v.user_queued_at);
  for (const video of listed) {
    if (includesContent(include, video.content_kind)) continue;
    if (video.status === "new" || video.status === "queued") {
      store.setStatus(video.video_id, "skipped", { skipKind: "content", now });
      result.skipped += 1;
    } else if (video.status === "skipped" && video.skip_kind === "before_start") {
      store.setSkipKind(video.video_id, "content", now);
    }
  }

  const turnedOn = listed.filter((v) => v.status === "skipped" && v.skip_kind === "content" && includesContent(include, v.content_kind));
  const fromBefore = turnedOn.filter((v) => v.first_seen_at <= firstSyncAt);
  const addedDates = playlist.backfill.kind === "added_since" ? await deps.addedDates(playlist.id) : null;
  const { selected } = await selectBackfill(
    playlist.backfill,
    fromBefore.map((v) => ({ videoId: v.video_id, publishedAt: v.published_at })),
    { exactUploadDate: rememberedExactDates(store, deps.exactUploadDate), addedDates, today: now.slice(0, 10) },
  );
  // Listed after the follow began: new uploads, which a follow always keeps.
  const releaseTo = playlist.mode === "auto" ? "queued" : "new";
  for (const video of turnedOn) {
    if (!unchanged(store, video)) continue;
    if (video.first_seen_at > firstSyncAt || selected.has(video.video_id)) {
      store.setStatus(video.video_id, releaseTo, { now });
      result.released += 1;
    } else {
      store.setSkipKind(video.video_id, "before_start", now);
    }
  }
  return result;
}
