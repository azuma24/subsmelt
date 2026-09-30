import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MediaProfile } from "./playlists.js";
import { videoUrl } from "./urls.js";

export const IMAGE_YTDLP_PATH = "/usr/local/bin/yt-dlp";
const DEFAULT_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 1_000_000;
export const PROGRESS_PREFIX = "[subsmelt-progress] ";

export type YtdlpErrorClass =
  | "rate_limited"
  | "bot_check"
  | "unavailable"
  | "members_only"
  | "upcoming"
  | "format"
  | "other";

export interface DownloadRequest {
  videoId: string;
  profile: MediaProfile;
  /** False drops the codec preference from the sort, the one retry after a `format` error. */
  codecPreference?: boolean;
  tmpDir: string;
  homeDir: string;
  cookiesPath?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Stdout outgrew maxCaptureBytes and lost its start: never parse it as a document. */
  stdoutTruncated: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  /** Output kept per stream; older output is dropped past it and stdoutTruncated set. */
  maxCaptureBytes?: number;
}

function dataDir(): string {
  return process.env.DATA_DIR || "./data";
}

export function dataYtdlpPath(): string {
  return path.resolve(dataDir(), "bin", "yt-dlp");
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/** SUBSMELT_YTDLP_BIN, then the updatable copy under DATA_DIR, then the image binary, then PATH. */
export function resolveYtdlpBin(): string | null {
  const pinned = process.env.SUBSMELT_YTDLP_BIN;
  if (pinned) return isExecutable(pinned) ? pinned : null;
  for (const candidate of [dataYtdlpPath(), IMAGE_YTDLP_PATH]) {
    if (isExecutable(candidate)) return candidate;
  }
  return findOnPath("yt-dlp");
}

function appendCapped(buffer: string, chunk: string, max: number): string {
  const next = buffer + chunk;
  return next.length > max ? next.slice(-max) : next;
}

// yt-dlp runs ffmpeg and node as children; killing only yt-dlp would leave them running.
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

const running = new Set<ChildProcess>();
let exitHooked = false;

// A detached group gets neither the terminal's Ctrl-C nor a service stop, so the server passes them on.
function stopTreesOnExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  const killAll = () => {
    for (const child of running) killTree(child);
  };
  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      killAll();
      process.kill(process.pid, signal);
    });
  }
}

/**
 * Spawns without a shell, in its own process group, so a timeout or abort
 * kills yt-dlp and everything it started. Resolves on exit, timeout or abort;
 * rejects only if the binary cannot start.
 */
export function runBinary(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, onStdoutLine, maxCaptureBytes = MAX_CAPTURE_BYTES } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ code: null, stdout: "", stderr: "", timedOut: false, stdoutTruncated: false });
    stopTreesOnExit();
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    running.add(child);
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let timedOut = false;
    let stdoutTruncated = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => killTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      running.delete(child);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdoutTruncated ||= stdout.length + chunk.length > maxCaptureBytes;
      stdout = appendCapped(stdout, chunk, maxCaptureBytes);
      if (!onStdoutLine) return;
      const lines = (pendingLine + chunk).split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) onStdoutLine(line);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk, maxCaptureBytes);
    });
    child.on("error", (err) => {
      settle();
      reject(err);
    });
    child.on("close", (code) => {
      settle();
      if (onStdoutLine && pendingLine) onStdoutLine(pendingLine);
      resolve({ code, stdout, stderr, timedOut, stdoutTruncated });
    });
  });
}

function requireYtdlp(): string {
  const bin = resolveYtdlpBin();
  if (!bin) throw new Error("yt-dlp is not installed");
  return bin;
}

export function runYtdlp(args: string[], options?: RunOptions): Promise<RunResult> {
  return runBinary(requireYtdlp(), args, options);
}

const ERROR_PATTERNS: [YtdlpErrorClass, RegExp][] = [
  ["rate_limited", /HTTP Error 429|Too Many Requests/i],
  ["bot_check", /Sign in to confirm you[’']re not a bot/i],
  ["members_only", /members[- ]only content|available to this channel's members/i],
  ["upcoming", /Premieres in|live event will begin|This live event will|is upcoming/i],
  ["format", /Requested format is not available/i],
  ["unavailable", /Private video|Video unavailable|This video is unavailable|video has been removed|account associated with this video has been terminated/i],
];

/** The line worth showing a user: the last ERROR line, else the last line. */
export function errorSummary(stderr: string, code: number | null): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) => l.startsWith("ERROR:")).pop() ?? lines.pop() ?? `yt-dlp exited with ${code}`;
}

export function classifyYtdlpError(stderr: string): YtdlpErrorClass {
  for (const [cls, pattern] of ERROR_PATTERNS) {
    if (pattern.test(stderr)) return cls;
  }
  return "other";
}

// yt-dlp matches sort values as regexes, so "av1" ranks AV1 formats and "m4a" ranks AAC ones.
function formatArgs(profile: MediaProfile, codecPreference: boolean): string[] {
  if (profile.type === "audio") {
    const sort = codecPreference ? `lang,acodec:${profile.format}` : "lang";
    return ["-f", "ba/b", "-S", sort, "-x", "--audio-format", profile.format];
  }
  const acodec = profile.container === "mp4" ? "aac" : "opus";
  const codecs = codecPreference ? [...(profile.codec === "any" ? [] : [`vcodec:${profile.codec}`]), `acodec:${acodec}`] : [];
  return [
    "-f", "bv*+ba/b",
    "-S", ["lang", `res:${profile.maxHeight}`, ...codecs].join(","),
    "--merge-output-format", profile.container,
  ];
}

export function downloadArgs(req: DownloadRequest): string[] {
  return [
    "--js-runtimes", "node",
    "--no-playlist",
    "--newline",
    "--progress-template", `download:${PROGRESS_PREFIX}%(progress)j`,
    "--paths", `temp:${req.tmpDir}`,
    "--paths", `home:${req.homeDir}`,
    "-o", "%(title).120B [%(id)s].%(ext)s",
    "--windows-filenames",
    "--write-info-json",
    "--sleep-requests", "1",
    "--sleep-interval", "2",
    "--max-sleep-interval", "8",
    ...(req.cookiesPath ? ["--cookies", req.cookiesPath] : []),
    ...formatArgs(req.profile, req.codecPreference ?? true),
    "--",
    videoUrl(req.videoId),
  ];
}

export interface CaptionRequest {
  videoId: string;
  /** The caption's key in the info JSON's `subtitles`, such as "en" or "zh-Hant". */
  lang: string;
  tmpDir: string;
  homeDir: string;
  cookiesPath?: string;
}

/**
 * Downloads one creator caption as SRT and nothing else. yt-dlp reads
 * --sub-langs as regular expressions, so the key is anchored and escaped:
 * "en" must not also fetch "en-GB". --write-subs never includes YouTube's
 * automatic captions.
 */
export function captionArgs(req: CaptionRequest): string[] {
  const pattern = `^${req.lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  return [
    "--js-runtimes", "node",
    "--no-playlist",
    "--skip-download",
    "--write-subs",
    "--sub-langs", pattern,
    "--convert-subs", "srt",
    "--paths", `temp:${req.tmpDir}`,
    "--paths", `home:${req.homeDir}`,
    "-o", "%(id)s.%(ext)s",
    "--sleep-requests", "1",
    ...(req.cookiesPath ? ["--cookies", req.cookiesPath] : []),
    "--",
    videoUrl(req.videoId),
  ];
}

export async function ytdlpVersion(): Promise<string | null> {
  const bin = resolveYtdlpBin();
  if (!bin) return null;
  const result = await runBinary(bin, ["--version"]).catch(() => null);
  return result?.code === 0 ? result.stdout.trim() || null : null;
}

/** First line of `ffmpeg -version`, or null when ffmpeg cannot run. */
export async function ffmpegVersion(): Promise<string | null> {
  const result = await runBinary("ffmpeg", ["-version"]).catch(() => null);
  if (result?.code !== 0) return null;
  return result.stdout.split("\n")[0].trim() || null;
}

// A pinned binary is updated in place: copying it would leave the pin pointing at the old one.
function updatableBinary(): string {
  if (process.env.SUBSMELT_YTDLP_BIN) return requireYtdlp();
  const target = dataYtdlpPath();
  if (isExecutable(target)) return target;
  const source = [IMAGE_YTDLP_PATH, findOnPath("yt-dlp")].find((p): p is string => !!p && isExecutable(p));
  if (!source) throw new Error("yt-dlp is not installed");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  return target;
}

export async function updateYtdlp(): Promise<{ path: string; version: string | null; output: string }> {
  const bin = updatableBinary();
  const result = await runBinary(bin, ["-U"], { timeoutMs: UPDATE_TIMEOUT_MS });
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.timedOut) throw new Error("yt-dlp update timed out");
  if (result.code !== 0) throw new Error(output.split("\n").pop() || `yt-dlp -U exited with ${result.code}`);
  return { path: bin, version: await ytdlpVersion(), output };
}
