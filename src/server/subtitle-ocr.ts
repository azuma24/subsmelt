import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedSubtitleImport, EmbeddedSubtitleTrack } from "../shared/embedded-subtitles.js";
import {
  allowsSubtitleFormat,
  checkDestination,
  CONTAINER_INPUT,
  EmbeddedSubtitleError,
  publishSubtitleSidecar,
} from "./embedded-subtitles.js";
import { standardLangCode } from "./language-codes.js";
import { hasValidSubtitleText, readSubtitleText } from "./subtitle-text.js";
import { languageKey } from "./youtube/subtitle-routes.js";

const OCR_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle"]);
const MAX_BITMAP_BYTES = 256 * 1024 * 1024;
const MAX_TOOL_STDOUT = 1024 * 1024;
let busy = false;

export function supportsSubtitleOcr(track: EmbeddedSubtitleTrack): boolean {
  return OCR_CODECS.has(track.codec);
}

function configuredHelper(): string | null {
  const helper = process.env.SUBSMELT_SECONV_PATH;
  return helper && path.isAbsolute(helper) ? helper : null;
}

function runOcrTool(
  command: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
  scratch?: string,
): Promise<string> {
  signal.throwIfAborted();
  const useProcessGroup = process.platform !== "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: scratch,
      env: scratch ? { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } : process.env,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let failure: unknown;
    let size = 0;
    const stdout: Buffer[] = [];
    const stop = (reason: unknown) => {
      if (failure) return;
      failure = reason;
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The process group may have already exited.
        }
      }
      child.kill("SIGKILL");
    };
    const abort = () => stop(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error("Subtitle OCR tool timed out")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_TOOL_STDOUT) stdout.push(chunk);
      else stop(new Error("Subtitle OCR tool output limit exceeded"));
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new Error("Subtitle OCR tool failed"));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function ocrEngineReady(helper: string, signal: AbortSignal): Promise<boolean> {
  try {
    const output = await runOcrTool(helper, ["list-ocr-engines", "--json"], 5_000, signal);
    const parsed = JSON.parse(output) as { engines?: { id?: string; ready?: boolean }[] };
    return parsed.engines?.some((engine) => engine.id === "tesseract" && engine.ready === true) === true;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

export async function subtitleOcrAvailable(signal: AbortSignal): Promise<boolean> {
  const helper = configuredHelper();
  return Boolean(helper && allowsSubtitleFormat("srt") && (await ocrEngineReady(helper, signal)));
}

function ocrLanguage(track: EmbeddedSubtitleTrack): string {
  const configured = process.env.SUBSMELT_SECONV_OCR_LANGUAGE;
  if (configured) {
    if (!/^[a-z]{3}(?:_[a-zA-Z]{3,8})?$/.test(configured)) {
      throw new EmbeddedSubtitleError(503, "The configured OCR language is invalid.");
    }
    return configured;
  }
  const key = languageKey(track.language ?? "en");
  if (key === "zh-Hant") return "chi_tra";
  if (key === "zh-Hans" || key === "zh") return "chi_sim";
  if (key.startsWith("pt-")) return "por";
  return standardLangCode(track.language ?? "eng");
}

export async function ocrEmbeddedSubtitle(
  file: string,
  revision: string,
  track: EmbeddedSubtitleTrack,
  signal: AbortSignal,
): Promise<EmbeddedSubtitleImport> {
  if (!supportsSubtitleOcr(track)) throw new EmbeddedSubtitleError(422, "This track is not a PGS or VobSub subtitle.");
  const helper = configuredHelper();
  if (!helper) throw new EmbeddedSubtitleError(503, "Subtitle Edit OCR is unavailable on the server.");
  const destination = checkDestination(file, track, "srt");
  if (busy) throw new EmbeddedSubtitleError(429, "Another subtitle OCR import is running.");
  busy = true;
  let scratch: string | undefined;
  try {
    if (!(await ocrEngineReady(helper, signal))) {
      throw new EmbeddedSubtitleError(503, "Subtitle Edit or its Tesseract OCR engine is unavailable.");
    }
    const language = ocrLanguage(track);
    scratch = await mkdtemp(path.join(os.tmpdir(), "subsmelt-ocr-"));
    const bitmap = path.join(scratch, "track.mks");
    await runOcrTool(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        ...CONTAINER_INPUT,
        "-copyts",
        "-i",
        file,
        "-map",
        `0:${track.index}`,
        "-c:s",
        "copy",
        "-map_chapters",
        "-1",
        "-map_metadata",
        "-1",
        "-avoid_negative_ts",
        "disabled",
        "-f",
        "matroska",
        "-fs",
        String(MAX_BITMAP_BYTES),
        bitmap,
      ],
      120_000,
      signal,
      scratch,
    );
    const imageFile = await stat(bitmap);
    if (!imageFile.isFile() || imageFile.size >= MAX_BITMAP_BYTES) {
      throw new EmbeddedSubtitleError(422, "The selected bitmap subtitle is too large for OCR.");
    }
    const result = await runOcrTool(
      helper,
      [
        bitmap,
        "subrip",
        `--output-folder:${scratch}`,
        "--output-filename:subtitle.srt",
        "--encoding:utf-8-no-bom",
        "--ocr-engine:tesseract",
        `--ocr-language:${language}`,
        "--json",
      ],
      10 * 60_000,
      signal,
      scratch,
    );
    if ((JSON.parse(result) as { success?: boolean }).success !== true) {
      throw new EmbeddedSubtitleError(422, "Subtitle Edit could not read the selected bitmap track.");
    }
    const content = await readSubtitleText(path.join(scratch, "subtitle.srt"));
    if (!hasValidSubtitleText(content, "srt")) {
      throw new EmbeddedSubtitleError(422, "OCR did not produce valid, timed subtitle text.");
    }
    return await publishSubtitleSidecar(file, revision, destination, content, signal);
  } catch (error) {
    if (error instanceof EmbeddedSubtitleError || signal.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EmbeddedSubtitleError(503, "An OCR executable or result file is unavailable.");
    }
    throw new EmbeddedSubtitleError(422, "The selected bitmap subtitle could not be read with OCR.");
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    busy = false;
  }
}
