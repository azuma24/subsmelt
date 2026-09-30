import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-ytdlp-"));
process.env.DATA_DIR = path.join(scratch, "data");
process.env.CONFIG_DIR = path.join(scratch, "config");
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-yt-dlp.mjs");

const { classifyYtdlpError, downloadArgs, resolveYtdlpBin, runYtdlp, updateYtdlp, ytdlpVersion, dataYtdlpPath } =
  await import("./ytdlp.js");
const { youtubeStatus } = await import("../routes/youtube.js");

function withEnv(vars: Record<string, string | undefined>, t: { after: (fn: () => void) => void }) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("classifyYtdlpError maps real yt-dlp error lines to their class", () => {
  const cases: [string, string][] = [
    ["ERROR: unable to download video data: HTTP Error 429: Too Many Requests", "rate_limited"],
    ["ERROR: [youtube] qD0_yWgifDM: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies", "bot_check"],
    ["ERROR: [youtube] qD0_yWgifDM: Sign in to confirm you're not a bot.", "bot_check"],
    ["ERROR: [youtube] qD0_yWgifDM: Private video. Sign in if you've been granted access to this video", "unavailable"],
    ["ERROR: [youtube] qD0_yWgifDM: Video unavailable. This video is no longer available", "unavailable"],
    ["ERROR: [youtube] qD0_yWgifDM: This video is unavailable", "unavailable"],
    ["ERROR: [youtube] qD0_yWgifDM: Join this channel to get access to members-only content like this video", "members_only"],
    ["ERROR: [youtube] qD0_yWgifDM: Premieres in 5 hours", "upcoming"],
    ["ERROR: [youtube] qD0_yWgifDM: This live event will begin in 3 days.", "upcoming"],
    ["ERROR: [youtube] qD0_yWgifDM: Requested format is not available. Use --list-formats", "format"],
    ["ERROR: Postprocessing: Conversion failed!", "other"],
  ];
  for (const [line, cls] of cases) assert.equal(classifyYtdlpError(line), cls, line);
});

test("downloadArgs builds a video profile: node JS runtime, lang-first sort, cookies, validated URL last", () => {
  const args = downloadArgs({
    videoId: "qD0_yWgifDM",
    profile: { type: "video", maxHeight: 1080, codec: "h264", container: "mp4" },
    tmpDir: "/data/youtube/tmp/qD0_yWgifDM",
    homeDir: "/media/youtube/AI",
    cookiesPath: "/data/youtube/tmp/qD0_yWgifDM/cookies.txt",
  });
  assert.deepEqual(args.slice(0, 2), ["--js-runtimes", "node"]);
  assert.deepEqual(args.slice(-10), [
    "--cookies", "/data/youtube/tmp/qD0_yWgifDM/cookies.txt",
    "-f", "bv*+ba/b",
    "-S", "lang,res:1080,vcodec:h264,acodec:aac",
    "--merge-output-format", "mp4",
    "--", "https://www.youtube.com/watch?v=qD0_yWgifDM",
  ]);
  assert.ok(args.includes("temp:/data/youtube/tmp/qD0_yWgifDM"));
  assert.ok(args.includes("home:/media/youtube/AI"));
});

test("downloadArgs builds an audio profile without cookies and uses opus for mkv video", () => {
  const audio = downloadArgs({ videoId: "qD0_yWgifDM", profile: { type: "audio", format: "opus" }, tmpDir: "/t", homeDir: "/h" });
  assert.equal(audio.includes("--cookies"), false);
  assert.deepEqual(audio.slice(-9), ["-f", "ba/b", "-S", "lang,acodec:opus", "-x", "--audio-format", "opus", "--", "https://www.youtube.com/watch?v=qD0_yWgifDM"]);
  const mkv = downloadArgs({ videoId: "qD0_yWgifDM", profile: { type: "video", maxHeight: 720, codec: "vp9", container: "mkv" }, tmpDir: "/t", homeDir: "/h" });
  assert.ok(mkv.includes("lang,res:720,vcodec:vp9,acodec:opus"));
  assert.throws(() => downloadArgs({ videoId: "--exec=rm", profile: { type: "audio", format: "m4a" }, tmpDir: "/t", homeDir: "/h" }));
});

test("downloadArgs sorts by the stored codec names, leaves out any, and drops codecs on the format retry", () => {
  const sortOf = (args: string[]) => args[args.indexOf("-S") + 1];
  const video = (codec: "av1" | "any") => ({ type: "video" as const, maxHeight: 1080 as const, codec, container: "mp4" as const });
  assert.equal(sortOf(downloadArgs({ videoId: "qD0_yWgifDM", profile: video("av1"), tmpDir: "/t", homeDir: "/h" })), "lang,res:1080,vcodec:av1,acodec:aac");
  assert.equal(sortOf(downloadArgs({ videoId: "qD0_yWgifDM", profile: video("any"), tmpDir: "/t", homeDir: "/h" })), "lang,res:1080,acodec:aac");
  assert.equal(sortOf(downloadArgs({ videoId: "qD0_yWgifDM", profile: video("av1"), codecPreference: false, tmpDir: "/t", homeDir: "/h" })), "lang,res:1080");
  assert.equal(sortOf(downloadArgs({ videoId: "qD0_yWgifDM", profile: { type: "audio", format: "m4a" }, codecPreference: false, tmpDir: "/t", homeDir: "/h" })), "lang");
});

test("SUBSMELT_YTDLP_BIN wins over the DATA_DIR copy; the DATA_DIR copy wins over PATH", (t) => {
  withEnv({ SUBSMELT_YTDLP_BIN: FAKE }, t);
  assert.equal(resolveYtdlpBin(), FAKE);
  delete process.env.SUBSMELT_YTDLP_BIN;
  fs.mkdirSync(path.dirname(dataYtdlpPath()), { recursive: true });
  fs.copyFileSync(FAKE, dataYtdlpPath());
  fs.chmodSync(dataYtdlpPath(), 0o755);
  t.after(() => fs.rmSync(dataYtdlpPath(), { force: true }));
  assert.equal(resolveYtdlpBin(), dataYtdlpPath());
});

test("a pinned SUBSMELT_YTDLP_BIN that is missing resolves to nothing instead of falling back", (t) => {
  withEnv({ SUBSMELT_YTDLP_BIN: path.join(scratch, "missing") }, t);
  assert.equal(resolveYtdlpBin(), null);
});

test("runYtdlp passes arguments verbatim, reports exit code, stderr and stdout lines", async (t) => {
  const argvFile = path.join(scratch, "argv.jsonl");
  withEnv({
    SUBSMELT_YTDLP_BIN: FAKE,
    FAKE_YTDLP_ARGV_FILE: argvFile,
    FAKE_YTDLP_STDOUT: "line one\nline; $(two)\n",
    FAKE_YTDLP_STDERR: "ERROR: HTTP Error 429: Too Many Requests\n",
    FAKE_YTDLP_EXIT: "1",
  }, t);
  const lines: string[] = [];
  const result = await runYtdlp(["--flat-playlist", "a b; rm -rf /"], { onStdoutLine: (l) => lines.push(l) });
  assert.equal(result.code, 1);
  assert.equal(result.timedOut, false);
  assert.deepEqual(lines, ["line one", "line; $(two)"]);
  assert.equal(classifyYtdlpError(result.stderr), "rate_limited");
  assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8").trim()), ["--flat-playlist", "a b; rm -rf /"]);
});

test("runYtdlp kills a hung process at the timeout", async (t) => {
  withEnv({ SUBSMELT_YTDLP_BIN: FAKE, FAKE_YTDLP_SLEEP_MS: "10000" }, t);
  const started = Date.now();
  const result = await runYtdlp(["x"], { timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000);
});

async function processGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function childPidOf(file: string): Promise<number> {
  while (!fs.existsSync(file) || !fs.readFileSync(file, "utf8")) await new Promise((r) => setTimeout(r, 10));
  return Number(fs.readFileSync(file, "utf8"));
}

test("a timeout kills the whole process tree, not only yt-dlp", async (t) => {
  const pidFile = path.join(scratch, "timeout-child.pid");
  withEnv({ SUBSMELT_YTDLP_BIN: FAKE, FAKE_YTDLP_SLEEP_MS: "10000", FAKE_YTDLP_CHILD_PID_FILE: pidFile }, t);
  const result = await runYtdlp(["x"], { timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  assert.equal(await processGone(await childPidOf(pidFile)), true);
});

test("an abort kills the whole process tree", async (t) => {
  const pidFile = path.join(scratch, "abort-child.pid");
  withEnv({ SUBSMELT_YTDLP_BIN: FAKE, FAKE_YTDLP_SLEEP_MS: "10000", FAKE_YTDLP_CHILD_PID_FILE: pidFile }, t);
  const controller = new AbortController();
  const running = runYtdlp(["x"], { signal: controller.signal, timeoutMs: 20_000 });
  const child = await childPidOf(pidFile);
  controller.abort();
  const result = await running;
  assert.equal(result.code, null);
  assert.equal(await processGone(child), true);
});

test("ytdlpVersion and the status route report the resolved binary", async (t) => {
  withEnv({ SUBSMELT_YTDLP_BIN: FAKE, FAKE_YTDLP_VERSION: "2026.09.01" }, t);
  assert.equal(await ytdlpVersion(), "2026.09.01");
  const status = await youtubeStatus();
  assert.deepEqual(status.ytdlp, { available: true, version: "2026.09.01", path: FAKE });
});

test("status reports yt-dlp unavailable when no binary resolves", async (t) => {
  withEnv({ SUBSMELT_YTDLP_BIN: path.join(scratch, "missing") }, t);
  const status = await youtubeStatus();
  assert.deepEqual(status.ytdlp, { available: false, version: null, path: null });
});

test("updateYtdlp runs -U on a pinned binary in place and never copies it", async (t) => {
  const argvFile = path.join(scratch, "update-argv.jsonl");
  withEnv({ SUBSMELT_YTDLP_BIN: FAKE, FAKE_YTDLP_ARGV_FILE: argvFile, FAKE_YTDLP_STDOUT: "yt-dlp is up to date\n" }, t);
  const result = await updateYtdlp();
  assert.equal(result.path, FAKE);
  assert.equal(result.output, "yt-dlp is up to date");
  assert.deepEqual(fs.readFileSync(argvFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)), [["-U"], ["--version"]]);
  assert.equal(fs.existsSync(dataYtdlpPath()), false);
});

test("updateYtdlp copies a PATH binary into DATA_DIR/bin before updating it", async (t) => {
  const pathDir = path.join(scratch, "pathbin");
  fs.mkdirSync(pathDir, { recursive: true });
  fs.copyFileSync(FAKE, path.join(pathDir, "yt-dlp"));
  fs.chmodSync(path.join(pathDir, "yt-dlp"), 0o755);
  withEnv({ SUBSMELT_YTDLP_BIN: undefined, PATH: `${pathDir}${path.delimiter}${path.dirname(process.execPath)}` }, t);
  t.after(() => fs.rmSync(dataYtdlpPath(), { force: true }));
  if (fs.existsSync("/usr/local/bin/yt-dlp")) return t.skip("image binary present on this host");
  const result = await updateYtdlp();
  assert.equal(result.path, dataYtdlpPath());
  assert.equal(fs.existsSync(dataYtdlpPath()), true);
  assert.equal(resolveYtdlpBin(), dataYtdlpPath());
});

test("updateYtdlp surfaces a failed update as an error", async (t) => {
  withEnv({ SUBSMELT_YTDLP_BIN: FAKE, FAKE_YTDLP_STDERR: "ERROR: Unable to write to /usr/local/bin/yt-dlp\n", FAKE_YTDLP_EXIT: "1" }, t);
  await assert.rejects(updateYtdlp(), /Unable to write/);
});
