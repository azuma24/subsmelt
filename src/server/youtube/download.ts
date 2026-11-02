import fs from "node:fs";
import path from "node:path";
import { copyCookiesInto } from "./cookies.js";
import type { MediaProfile } from "./playlists.js";
import type { VideoMetadata } from "./store.js";
import {
  classifyYtdlpError,
  downloadArgs,
  errorSummary,
  PROGRESS_PREFIX,
  runYtdlp,
  type YtdlpErrorClass,
} from "./ytdlp.js";
import { mkdirShared, shareFile } from "../shared-files.js";

const MIN_TIMEOUT_MS = 60 * 60_000;
const MEDIA_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".m4a", ".opus", ".ogg", ".mka"]);
// The info JSON of one video is about 700 KB, nearly all of it format lists and expiring URLs.
// `cookies` holds the session cookie header whenever cookies were used, and must never reach the media folder.
const INFO_KEYS_DROPPED = [
  "formats",
  "requested_formats",
  "requested_downloads",
  "automatic_captions",
  "thumbnails",
  "http_headers",
  "url",
  "cookies",
];
const UPCOMING_RE = /(?:premieres|begin|starts?) in (\d+) (minute|hour|day|week)s?/i;
const UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
const DEFAULT_UPCOMING_MS = 3_600_000;

export type DownloadResult =
  | { ok: true; mediaFile: string; meta: VideoMetadata }
  | { ok: false; errorClass: YtdlpErrorClass; message: string };

export interface DownloadRequest {
  videoId: string;
  durationS: number | null;
  profile: MediaProfile;
  /** This video's own scratch folder, emptied first and removed afterwards. */
  tmpDir: string;
  /** The playlist folder the finished files move into. */
  destDir: string;
  onProgress: (pct: number) => void;
  signal?: AbortSignal;
}

/** The larger of an hour and twice the video's length. */
export function downloadTimeoutMs(durationS: number | null): number {
  return Math.max(MIN_TIMEOUT_MS, (durationS ?? 0) * 2000);
}

/** When to look again at a premiere or live stream, from yt-dlp's "Premieres in 5 hours". */
export function upcomingRetryAt(stderr: string, now: Date): string {
  const match = UPCOMING_RE.exec(stderr);
  const ms = match ? Number(match[1]) * UNIT_MS[match[2].toLowerCase()] : DEFAULT_UPCOMING_MS;
  return new Date(now.getTime() + ms).toISOString();
}

/**
 * Turns `[subsmelt-progress]` lines into one percentage for the whole
 * download. A video profile downloads two files (video, then audio), so each
 * file is half of the bar; a file yt-dlp did not announce widens the split.
 */
export function createProgressTracker(expectedFiles: number): (line: string) => number | null {
  const files: string[] = [];
  return (line) => {
    if (!line.startsWith(PROGRESS_PREFIX)) return null;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as Record<string, unknown>;
    } catch {
      return null;
    }
    const file = typeof p.filename === "string" ? p.filename : "";
    if (!files.includes(file)) files.push(file);
    const done = Number(p.downloaded_bytes);
    const total = Number(p.total_bytes) || Number(p.total_bytes_estimate);
    const fraction =
      p.status === "finished"
        ? 1
        : total > 0 && done >= 0
          ? Math.min(1, done / total)
          : Number(p.fragment_count) > 0
            ? Math.min(1, Number(p.fragment_index) / Number(p.fragment_count))
            : 0;
    const share = Math.max(expectedFiles, files.length);
    return Math.min(99, Math.floor(((files.indexOf(file) + fraction) / share) * 100));
  };
}

/** The finished media file for a video in `dir`, found by the id in its name, brackets or not. */
export function findDownloadedMedia(dir: string, videoId: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  return names.find((name) => name.includes(videoId) && MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) ?? null;
}

const PARTIAL_SUFFIX = ".subsmelt-partial";

/**
 * What a crashed run left in the playlist folder: removes half-copied files
 * of the video and returns the metadata of an info JSON already moved there.
 */
export function tidyPlaylistFolder(dir: string, videoId: string): VideoMetadata {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.includes(`[${videoId}].`));
  } catch {
    return {};
  }
  for (const name of names.filter((n) => n.endsWith(PARTIAL_SUFFIX))) fs.rmSync(path.join(dir, name), { force: true });
  const info = names.find((name) => name.endsWith(".info.json"));
  return info ? slimInfo(path.join(dir, info)) : {};
}

function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Another filesystem: copy under a name the existence check ignores, then rename into place.
    const staging = `${dest}${PARTIAL_SUFFIX}`;
    fs.copyFileSync(src, staging);
    fs.renameSync(staging, dest);
    fs.rmSync(src, { force: true });
  }
  shareFile(dest);
}

/**
 * Moves every finished file into `destDir`, the media file last, so a crash
 * part-way leaves no media file and the next run downloads again.
 */
function moveFinished(srcDir: string, destDir: string, mediaFile: string): void {
  mkdirShared(destDir);
  const others = fs.readdirSync(srcDir).filter((name) => name !== mediaFile);
  for (const name of [...others, mediaFile]) moveFile(path.join(srcDir, name), path.join(destDir, name));
}

/** Slims the info JSON in place and returns what the store keeps; a file that does not parse is deleted. */
function slimInfo(file: string): VideoMetadata {
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    fs.rmSync(file, { force: true });
    return {};
  }
  for (const key of INFO_KEYS_DROPPED) delete info[key];
  fs.writeFileSync(file, JSON.stringify(info));
  const uploaded = typeof info.upload_date === "string" && /^\d{8}$/.test(info.upload_date) ? info.upload_date : null;
  return {
    title: typeof info.title === "string" ? info.title : null,
    channel: typeof info.channel === "string" ? info.channel : typeof info.uploader === "string" ? info.uploader : null,
    durationS: typeof info.duration === "number" ? Math.round(info.duration) : null,
    publishedAt: uploaded ? `${uploaded.slice(0, 4)}-${uploaded.slice(4, 6)}-${uploaded.slice(6, 8)}` : null,
  };
}

async function runOnce(
  req: DownloadRequest,
  cookies: string | null,
  codecPreference: boolean,
): Promise<DownloadResult> {
  const partDir = path.join(req.tmpDir, "part");
  const outDir = path.join(req.tmpDir, "out");
  for (const dir of [partDir, outDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  const track = createProgressTracker(req.profile.type === "video" ? 2 : 1);
  const args = downloadArgs({
    videoId: req.videoId,
    profile: req.profile,
    codecPreference,
    tmpDir: partDir,
    homeDir: outDir,
    cookiesPath: cookies ?? undefined,
  });
  const timeoutMs = downloadTimeoutMs(req.durationS);
  const result = await runYtdlp(args, {
    timeoutMs,
    signal: req.signal,
    onStdoutLine: (line) => {
      const pct = track(line);
      if (pct !== null) req.onProgress(pct);
    },
  });
  if (result.timedOut)
    return {
      ok: false,
      errorClass: "other",
      message: `Download timed out after ${Math.round(timeoutMs / 60_000)} minutes`,
    };
  if (result.code !== 0)
    return {
      ok: false,
      errorClass: classifyYtdlpError(result.stderr),
      message: errorSummary(result.stderr, result.code),
    };

  const mediaFile = findDownloadedMedia(outDir, req.videoId);
  if (!mediaFile) return { ok: false, errorClass: "other", message: "yt-dlp finished without writing a media file" };
  const infoFile = fs.readdirSync(outDir).find((name) => name.endsWith(".info.json"));
  const meta = infoFile ? slimInfo(path.join(outDir, infoFile)) : {};
  moveFinished(outDir, req.destDir, mediaFile);
  return { ok: true, mediaFile, meta };
}

/**
 * Downloads one video into its scratch folder and moves the result into the
 * playlist folder. A format error gets one more try without the codec
 * preference. The scratch folder, cookie copy included, is gone afterwards.
 */
export async function downloadVideo(req: DownloadRequest): Promise<DownloadResult> {
  fs.rmSync(req.tmpDir, { recursive: true, force: true });
  fs.mkdirSync(req.tmpDir, { recursive: true });
  try {
    const cookies = copyCookiesInto(req.tmpDir);
    const first = await runOnce(req, cookies, true);
    if (first.ok || first.errorClass !== "format" || req.signal?.aborted) return first;
    return await runOnce(req, cookies, false);
  } finally {
    fs.rmSync(req.tmpDir, { recursive: true, force: true });
  }
}
