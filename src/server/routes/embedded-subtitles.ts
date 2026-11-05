import { execFile } from "node:child_process";
import { link, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Express } from "express";
import {
  canProbeEmbeddedSubtitles,
  type EmbeddedSubtitleImport,
  type EmbeddedSubtitleProbe,
  type EmbeddedSubtitleTrack,
} from "../../shared/embedded-subtitles.js";
import { getSetting, preferredChinese } from "../config.js";
import { standardLangCode } from "../language-codes.js";
import { findAnyCase, stripLangSuffix } from "../output-names.js";
import { MEDIA_DIR } from "../scanner.js";
import { shareFile } from "../shared-files.js";
import { assertMediaPathAllowed } from "../transcription/request.js";
import { cuesOf, parseSubtitle } from "../translator/convert.js";

const runTool = promisify(execFile);
const CONTAINER_INPUT = ["-protocol_whitelist", "file", "-format_whitelist", "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2"];
const FORMATS = new Map<string, NonNullable<EmbeddedSubtitleTrack["format"]>>([
  ["subrip", "srt"],
  ["mov_text", "srt"],
  ["ass", "ass"],
  ["ssa", "ssa"],
  ["webvtt", "vtt"],
]);
const MUXERS = { srt: "srt", ass: "ass", ssa: "ass", vtt: "webvtt" };
const BITMAP_CODECS = new Set(["dvd_subtitle", "dvb_subtitle", "hdmv_pgs_subtitle", "xsub"]);
const SAFE_LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/;

class EmbeddedSubtitleError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function allowedVideo(input: unknown): string {
  if (typeof input !== "string" || !canProbeEmbeddedSubtitles(input) || input.includes("\0")) {
    throw new EmbeddedSubtitleError(400, "Select a video in the Library.");
  }
  try {
    return assertMediaPathAllowed(input, MEDIA_DIR);
  } catch {
    throw new EmbeddedSubtitleError(400, "Select a video in the Library.");
  }
}

async function videoRevision(file: string): Promise<string> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new EmbeddedSubtitleError(404, "The video file could not be opened.");
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
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
    language: language && language !== "und" && SAFE_LANGUAGE_TAG.test(language) ? language : null,
    title: title?.slice(0, 200) || null,
    isDefault: stream.disposition?.default === 1,
    isForced: stream.disposition?.forced === 1,
    isBitmap: BITMAP_CODECS.has(codec),
    format: FORMATS.get(codec) ?? null,
  };
}

async function probeVideo(file: string): Promise<EmbeddedSubtitleProbe> {
  const revision = await videoRevision(file);
  try {
    const { stdout } = await runTool(
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
      { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
    );
    const { streams = [] } = JSON.parse(stdout) as { streams?: ProbeStream[] };
    return { revision, tracks: streams.map(probeTrack) };
  } catch (error) {
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

async function extractTrack(
  file: string,
  revision: string,
  track: EmbeddedSubtitleTrack,
): Promise<EmbeddedSubtitleImport> {
  const format = track.format;
  if (!format) throw new EmbeddedSubtitleError(422, "This subtitle format is not supported for import.");
  if (
    !getSetting("subtitle_extensions")
      .split(",")
      .some((ext) => ext.trim().toLowerCase() === `.${format}`)
  ) {
    throw new EmbeddedSubtitleError(
      422,
      `Enable .${format} in the Library’s subtitle extensions to import this track.`,
    );
  }
  const destination = sidecarPath(file, track, format);
  if (findAnyCase(destination)) throw existingSidecar();
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
      { timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
    );
    content = stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new EmbeddedSubtitleError(503, "FFmpeg is unavailable on the server.");
    throw new EmbeddedSubtitleError(422, "The selected subtitle track could not be extracted.");
  }
  if (!cuesOf(parseSubtitle(content, format)).some((cue) => cue.data?.text?.trim())) {
    throw new EmbeddedSubtitleError(422, "The selected subtitle track has no text cues.");
  }

  // Stage in a private directory on the same filesystem. A hard link publishes
  // the complete subtitle atomically and fails if the destination was taken.
  const temporary = await mkdtemp(path.join(path.dirname(destination), ".subsmelt-import-"));
  try {
    const staged = path.join(temporary, "subtitle");
    await writeFile(staged, content);
    shareFile(staged);
    if ((await videoRevision(file)) !== revision) throw new EmbeddedSubtitleError(412, "The video changed.");
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

export function registerEmbeddedSubtitleRoutes(app: Express): void {
  app.get("/api/library/embedded-subtitles", async (req, res) => {
    try {
      res.json(await probeVideo(allowedVideo(req.query.videoPath)));
    } catch (error) {
      const known = error instanceof EmbeddedSubtitleError;
      res.status(known ? error.status : 500).json({ error: known ? error.message : "Could not inspect this video." });
    }
  });

  app.post("/api/library/embedded-subtitles", async (req, res) => {
    try {
      const { videoPath, index, revision } = req.body ?? {};
      if (!Number.isSafeInteger(index) || index < 0 || typeof revision !== "string") {
        throw new EmbeddedSubtitleError(400, "Select an embedded subtitle track.");
      }
      const file = allowedVideo(videoPath);
      const current = await probeVideo(file);
      if (current.revision !== revision) throw new EmbeddedSubtitleError(412, "The video changed.");
      const track = current.tracks.find((entry) => entry.index === index);
      if (!track) throw new EmbeddedSubtitleError(400, "This subtitle track was not found in the video.");
      res.json(await extractTrack(file, current.revision, track));
    } catch (error) {
      const known = error instanceof EmbeddedSubtitleError;
      res
        .status(known ? error.status : 500)
        .json({ error: known ? error.message : "Could not save the subtitle file." });
    }
  });
}
