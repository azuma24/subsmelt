import { execFile } from "node:child_process";
import { link, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  EmbeddedSubtitleImport,
  EmbeddedSubtitleProbe,
  EmbeddedSubtitleTrack,
} from "../shared/embedded-subtitles.js";
import { SUBTITLE_LANGUAGE_TAG } from "../shared/subtitle-intake.js";
import { getSetting, preferredChinese } from "./config.js";
import { standardLangCode } from "./language-codes.js";
import { findAnyCase, stripLangSuffix } from "./output-names.js";
import { shareFile } from "./shared-files.js";
import { hasValidSubtitleText } from "./subtitle-text.js";
import { cuesOf, parseSubtitle } from "./translator/convert.js";

const runTool = promisify(execFile);
export const CONTAINER_INPUT = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2",
];
const FORMATS = new Map<string, NonNullable<EmbeddedSubtitleTrack["format"]>>([
  ["subrip", "srt"],
  ["mov_text", "srt"],
  ["ass", "ass"],
  ["ssa", "ssa"],
  ["webvtt", "vtt"],
]);
const MUXERS = { srt: "srt", ass: "ass", ssa: "ass", vtt: "webvtt" };
const BITMAP_CODECS = new Set(["dvd_subtitle", "dvb_subtitle", "hdmv_pgs_subtitle", "xsub"]);

export class EmbeddedSubtitleError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const VIDEO_SETTLE_MS = 2_000;

export async function embeddedVideoIdentity(file: string): Promise<{ revision: string; changedAt: number }> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new EmbeddedSubtitleError(404, "The video file could not be opened.");
  return {
    revision: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    changedAt: Math.max(info.mtimeMs, info.ctimeMs),
  };
}

interface ProbeStream {
  index: number;
  codec_name?: string;
  disposition?: { default?: number; forced?: number };
  tags?: { language?: string; title?: string; handler_name?: string };
}

function probeTrack(stream: ProbeStream): EmbeddedSubtitleTrack {
  const codec = stream.codec_name ?? "unknown";
  const language = stream.tags?.language?.trim().toLowerCase();
  const title = stream.tags?.title?.trim() || stream.tags?.handler_name?.trim();
  return {
    index: stream.index,
    codec,
    language: language && language !== "und" && SUBTITLE_LANGUAGE_TAG.test(language) ? language : null,
    title: title?.slice(0, 200) || null,
    isDefault: stream.disposition?.default === 1,
    isForced: stream.disposition?.forced === 1,
    isBitmap: BITMAP_CODECS.has(codec),
    format: FORMATS.get(codec) ?? null,
  };
}

export async function probeVideo(
  file: string,
  options: { signal?: AbortSignal; requireClean?: boolean } = {},
): Promise<EmbeddedSubtitleProbe> {
  const { signal, requireClean } = options;
  const { revision } = await embeddedVideoIdentity(file);
  try {
    const { stdout, stderr } = await runTool(
      "ffprobe",
      [
        "-v",
        "error",
        ...CONTAINER_INPUT,
        "-select_streams",
        "s",
        "-show_entries",
        "stream=index,codec_name:stream_tags=language,title,handler_name:stream_disposition=default,forced",
        "-of",
        "json",
        file,
      ],
      { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, signal },
    );
    const { streams } = JSON.parse(stdout) as { streams?: ProbeStream[] };
    if (
      (requireClean && stderr.trim()) ||
      !Array.isArray(streams) ||
      streams.some((stream) => !Number.isSafeInteger(stream.index))
    ) {
      throw new Error("Incomplete FFprobe result");
    }
    if ((await embeddedVideoIdentity(file)).revision !== revision) {
      throw new EmbeddedSubtitleError(412, "The video changed.");
    }
    return { revision, tracks: streams.map(probeTrack) };
  } catch (error) {
    if (error instanceof EmbeddedSubtitleError || signal?.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new EmbeddedSubtitleError(503, "FFprobe is unavailable on the server.");
    throw new EmbeddedSubtitleError(422, "The video’s subtitle tracks could not be read.");
  }
}

function sidecarPath(file: string, track: EmbeddedSubtitleTrack, format: string): string {
  const { dir, name } = path.parse(file);
  const language = track.language ? standardLangCode(track.language, preferredChinese()) : "";
  // Keep the name readable by the scanner, which only strips known languages and flags.
  const flagged = track.isForced ? `${name}.${language}.forced` : `${name}.${language}`;
  const stem = stripLangSuffix(flagged) === name ? flagged : name;
  return path.join(dir, `${stem}.${format}`);
}

function existingSidecar(): EmbeddedSubtitleError {
  return new EmbeddedSubtitleError(409, "A subtitle file with this name already exists.");
}

export function allowsSubtitleFormat(format: string): boolean {
  return getSetting("subtitle_extensions")
    .split(",")
    .some((ext) => ext.trim().toLowerCase() === `.${format}`);
}

export function checkDestination(file: string, track: EmbeddedSubtitleTrack, format: string): string {
  if (!allowsSubtitleFormat(format)) {
    throw new EmbeddedSubtitleError(
      422,
      `Enable .${format} in the Library’s subtitle extensions to import this track.`,
    );
  }
  const destination = sidecarPath(file, track, format);
  if (findAnyCase(destination)) throw existingSidecar();
  return destination;
}

export async function extractTrack(
  file: string,
  revision: string,
  track: EmbeddedSubtitleTrack,
  options: { signal?: AbortSignal; validateTiming?: boolean } = {},
): Promise<EmbeddedSubtitleImport> {
  const { signal, validateTiming } = options;
  const format = track.format;
  if (!format) throw new EmbeddedSubtitleError(422, "This subtitle format is not supported for import.");
  const destination = checkDestination(file, track, format);
  let content: string;
  try {
    const { stdout } = await runTool(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        ...CONTAINER_INPUT,
        "-i",
        file,
        "-map",
        `0:${track.index}`,
        "-c:s",
        track.codec === "mov_text" ? "subrip" : "copy",
        "-f",
        MUXERS[format],
        "pipe:1",
      ],
      { timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, signal },
    );
    content = stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new EmbeddedSubtitleError(503, "FFmpeg is unavailable on the server.");
    throw new EmbeddedSubtitleError(422, "The selected subtitle track could not be extracted.");
  }
  const valid = validateTiming
    ? hasValidSubtitleText(content, format)
    : cuesOf(parseSubtitle(content, format)).some((cue) => cue.data?.text?.trim());
  if (!valid) {
    throw new EmbeddedSubtitleError(422, "The selected subtitle track has no text cues.");
  }

  return publishSubtitleSidecar(file, revision, destination, content, signal);
}

export async function publishSubtitleSidecar(
  file: string,
  revision: string,
  destination: string,
  content: string,
  signal?: AbortSignal,
  beforePublish?: (staged: string) => Promise<void>,
): Promise<EmbeddedSubtitleImport> {
  signal?.throwIfAborted();
  // Stage in a private directory on the same filesystem. A hard link publishes
  // the complete subtitle atomically and fails if the destination was taken.
  const temporary = await mkdtemp(path.join(path.dirname(destination), ".subsmelt-import-"));
  try {
    const staged = path.join(temporary, path.basename(destination));
    await writeFile(staged, content);
    shareFile(staged);
    if ((await embeddedVideoIdentity(file)).revision !== revision) {
      throw new EmbeddedSubtitleError(412, "The video changed.");
    }
    if (beforePublish) await beforePublish(staged);
    signal?.throwIfAborted();
    if (findAnyCase(destination)) throw existingSidecar();
    await link(staged, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw existingSidecar();
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  return { file: path.basename(destination) };
}
