import { isPlaylistId } from "./urls.js";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const PAGE_SIZE = 50;
// 200 pages is 10,000 videos, far past any playlist YouTube allows (5,000).
const MAX_PAGES = 200;
const REQUEST_TIMEOUT_MS = 15_000;
// Any public video works for a key check; this one has been up since 2009.
const KEY_TEST_VIDEO_ID = "dQw4w9WgXcQ";

type FetchLike = typeof fetch;

interface PlaylistItemsPage {
  nextPageToken?: string;
  items?: { snippet?: { publishedAt?: string; resourceId?: { videoId?: string } } }[];
}

async function getJson<T>(url: URL, fetchImpl: FetchLike): Promise<T> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  if (!res.ok) {
    const message =
      typeof body?.error?.message === "string" ? body.error.message : `YouTube Data API returned HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

/**
 * Video id to the date (YYYY-MM-DD) it was added to the playlist, read from
 * playlistItems.list. `snippet.publishedAt` there is the time the item was
 * added, not when the video was posted.
 */
export async function fetchAddedDates(
  playlistId: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<Map<string, string>> {
  if (!isPlaylistId(playlistId)) throw new Error(`Invalid playlist id: ${playlistId}`);
  const dates = new Map<string, string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${API_BASE}/playlistItems`);
    url.search = new URLSearchParams({
      part: "snippet",
      maxResults: String(PAGE_SIZE),
      playlistId,
      fields: "nextPageToken,items(snippet(publishedAt,resourceId/videoId))",
      key: apiKey,
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const body = await getJson<PlaylistItemsPage>(url, fetchImpl);
    for (const item of body.items ?? []) {
      const videoId = item.snippet?.resourceId?.videoId;
      const addedAt = item.snippet?.publishedAt;
      if (videoId && addedAt) dates.set(videoId, addedAt.slice(0, 10));
    }
    pageToken = body.nextPageToken;
    if (!pageToken) return dates;
  }
  return dates;
}

/** One videos.list call (1 quota unit). Resolves when Google accepts the key, throws its message otherwise. */
export async function testApiKey(apiKey: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const url = new URL(`${API_BASE}/videos`);
  url.search = new URLSearchParams({ part: "id", id: KEY_TEST_VIDEO_ID, key: apiKey }).toString();
  await getJson(url, fetchImpl);
}
