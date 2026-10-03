export const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

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

export function playlistUrl(id: string): string {
  if (!isPlaylistId(id)) throw new Error(`Invalid playlist id: ${id}`);
  return `https://www.youtube.com/playlist?list=${id}`;
}

export function videoUrl(id: string): string {
  if (!isVideoId(id)) throw new Error(`Invalid video id: ${id}`);
  return `https://www.youtube.com/watch?v=${id}`;
}
