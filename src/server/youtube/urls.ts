export const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
// A channel's uploads playlist: its channel id with UU in place of UC.
const UPLOADS_ID_RE = /^UU[A-Za-z0-9_-]{22}$/;
// Handles take letters and digits from any script, so a Han or Hangul handle can be one character.
const HANDLE_RE = /^@[\p{L}\p{M}\p{N}._·-]{1,30}$/u;
// The names behind the legacy /c/ and /user/ channel URLs.
const LEGACY_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

// Mix and radio playlists (RD…, radio "RP…") have session-shuffled membership:
// every sync lists different videos, which marks real entries removed and
// re-adds strangers, and the Data API refuses them outright. Following one is
// never what the operator meant, so they do not count as playlists.
const MIX_PLAYLIST_PREFIX_RE = /^(RD|LM|RP)/;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const SHORT_HOST = "youtu.be";
const LIST_PATHS = new Set(["/playlist", "/watch"]);
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isPlaylistId(s: string): boolean {
  return PLAYLIST_ID_RE.test(s);
}

export function isVideoId(s: string): boolean {
  return VIDEO_ID_RE.test(s);
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(HAS_SCHEME_RE.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
}

function carriesList(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.hostname === SHORT_HOST) return isVideoId(url.pathname.slice(1));
  return YOUTUBE_HOSTS.has(url.hostname) && LIST_PATHS.has(url.pathname);
}

/** Pasted text to a list id. Accepts a bare id, youtube.com / www / m / music.youtube.com
 *  playlist?list=, watch?v=..&list=.., youtu.be/..?list=.., with or without scheme and si= junk.
 *  Returns null for anything else (other hosts, missing list, bad id chars, a lone watch URL,
 *  a mix/radio playlist). */
export function parsePlaylistInput(input: string): string | null {
  const text = input.trim();
  if (isPlaylistId(text)) return MIX_PLAYLIST_PREFIX_RE.test(text) ? null : text;
  const url = parseUrl(text);
  if (!url || !carriesList(url)) return null;
  const list = url.searchParams.get("list") ?? "";
  if (!isPlaylistId(list)) return null;
  return MIX_PLAYLIST_PREFIX_RE.test(list) ? null : list;
}

/** A channel as pasted: its id when the link carries one, otherwise a canonical URL yt-dlp resolves. */
export type ChannelInput = { channelId: string } | { url: string };

/** Pasted text to a channel. Accepts a bare UC… id or @handle, and youtube.com /channel/UC…,
 *  /@handle, /c/name and /user/name links, with or without scheme, tab path (/videos) or si= junk.
 *  Returns null for anything else. */
export function parseChannelInput(input: string): ChannelInput | null {
  const text = input.trim();
  if (CHANNEL_ID_RE.test(text)) return { channelId: text };
  if (HANDLE_RE.test(text)) return { url: handleUrl(text) };
  const url = parseUrl(text);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !YOUTUBE_HOSTS.has(url.hostname)) return null;
  const [first = "", second = ""] = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  if (first === "channel") return CHANNEL_ID_RE.test(second) ? { channelId: second } : null;
  if (HANDLE_RE.test(first)) return { url: handleUrl(first) };
  if ((first === "c" || first === "user") && LEGACY_NAME_RE.test(second))
    return { url: `https://www.youtube.com/${first}/${second}` };
  return null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/** A handle's channel page, percent-encoded the way YouTube links it. */
function handleUrl(handle: string): string {
  return `https://www.youtube.com/@${encodeURIComponent(handle.slice(1))}`;
}

export function isChannelId(s: string): boolean {
  return CHANNEL_ID_RE.test(s);
}

export function uploadsPlaylistId(channelId: string): string {
  if (!isChannelId(channelId)) throw new Error(`Invalid channel id: ${channelId}`);
  return `UU${channelId.slice(2)}`;
}

/** A channel's uploads split by kind: YouTube keeps videos, Shorts and live streams in their own lists. */
export function channelContentLists(uploadsId: string): { video: string; short: string; live: string } {
  if (!isChannelUploads(uploadsId)) throw new Error(`Invalid uploads playlist id: ${uploadsId}`);
  const rest = uploadsId.slice(2);
  return { video: `UULF${rest}`, short: `UUSH${rest}`, live: `UULV${rest}` };
}

/** True for a followed channel, which is stored as its uploads playlist. */
export function isChannelUploads(playlistId: string): boolean {
  return UPLOADS_ID_RE.test(playlistId);
}

export function playlistUrl(id: string): string {
  if (!isPlaylistId(id)) throw new Error(`Invalid playlist id: ${id}`);
  return `https://www.youtube.com/playlist?list=${id}`;
}

export function videoUrl(id: string): string {
  if (!isVideoId(id)) throw new Error(`Invalid video id: ${id}`);
  return `https://www.youtube.com/watch?v=${id}`;
}
