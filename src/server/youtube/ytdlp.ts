import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

export type DownloadProfile =
  | { kind: "video"; maxHeight: number; codec: "h264" | "vp9" | "av01"; container: "mp4" | "mkv" }
  | { kind: "audio"; format: "m4a" | "opus" };

export interface DownloadRequest {
  videoId: string;
  profile: DownloadProfile;
  tmpDir: string;
  homeDir: string;
  cookiesPath?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  /** Output kept per stream; older output is dropped past it. */
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

/** Spawns without a shell. Resolves on exit, timeout or abort; rejects only if the binary cannot start. */
export function runBinary(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, onStdoutLine, maxCaptureBytes = MAX_CAPTURE_BYTES } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
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
      clearTimeout(timer);
      if (err.name === "AbortError") resolve({ code: null, stdout, stderr, timedOut });
      else reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (onStdoutLine && pendingLine) onStdoutLine(pendingLine);
      resolve({ code, stdout, stderr, timedOut });
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

export function classifyYtdlpError(stderr: string): YtdlpErrorClass {
  for (const [cls, pattern] of ERROR_PATTERNS) {
    if (pattern.test(stderr)) return cls;
  }
  return "other";
}

function formatArgs(profile: DownloadProfile): string[] {
  if (profile.kind === "audio") {
    return ["-f", "ba/b", "-S", `lang,acodec:${profile.format}`, "-x", "--audio-format", profile.format];
  }
  const acodec = profile.container === "mp4" ? "aac" : "opus";
  return [
    "-f", "bv*+ba/b",
    "-S", `lang,res:${profile.maxHeight},vcodec:${profile.codec},acodec:${acodec}`,
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
    ...formatArgs(req.profile),
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
