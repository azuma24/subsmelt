#!/usr/bin/env node
// Test double for yt-dlp. Behaviour comes from environment variables:
// FAKE_YTDLP_ARGV_FILE   append this run's argv as one JSON line
// FAKE_YTDLP_VERSION     printed for --version (default 2026.08.19)
// FAKE_YTDLP_STDOUT      written to stdout, one line per \n
// FAKE_YTDLP_STDOUT_FILE this file's contents written to stdout (for output too big for the environment)
// FAKE_YTDLP_STDERR      written to stderr
// FAKE_YTDLP_EXIT        exit code (default 0)
// FAKE_YTDLP_FAIL_WHEN_ARG  apply STDERR and EXIT only when some argument contains this text
// FAKE_YTDLP_SLEEP_MS    wait before exiting
// FAKE_YTDLP_CHILD_PID_FILE  start a long-lived child, as yt-dlp starts ffmpeg, and write its pid here
// A run with --paths is a download: it writes <temp>/<id>.part at once, and
// after the sleep, on success, "<title> [<id>].<ext>" and its .info.json in
// the home path, the way yt-dlp moves finished files there.
// FAKE_YTDLP_TITLE       title in the file name (default "Fake video")
// FAKE_YTDLP_INFO        JSON merged into the written info JSON
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const env = process.env;
if (env.FAKE_YTDLP_ARGV_FILE) fs.appendFileSync(env.FAKE_YTDLP_ARGV_FILE, `${JSON.stringify(args)}\n`);

if (args.includes("--version")) {
  process.stdout.write(`${env.FAKE_YTDLP_VERSION ?? "2026.08.19"}\n`);
  process.exit(0);
}

if (env.FAKE_YTDLP_CHILD_PID_FILE) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  fs.writeFileSync(env.FAKE_YTDLP_CHILD_PID_FILE, String(child.pid));
}

const failing = !env.FAKE_YTDLP_FAIL_WHEN_ARG || args.some((a) => a.includes(env.FAKE_YTDLP_FAIL_WHEN_ARG));
const exit = failing ? Number(env.FAKE_YTDLP_EXIT ?? 0) : 0;
const sleep = Number(env.FAKE_YTDLP_SLEEP_MS ?? 0);

const valueAfter = (flag, prefix = "") => {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1].startsWith(prefix)) return args[i + 1].slice(prefix.length);
  }
  return null;
};
const home = valueAfter("--paths", "home:");
const temp = valueAfter("--paths", "temp:");
const videoId = temp ? new URL(args[args.length - 1]).searchParams.get("v") : null;

if (temp) {
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(path.join(temp, `${videoId}.part`), "partial");
}
if (env.FAKE_YTDLP_STDOUT) process.stdout.write(env.FAKE_YTDLP_STDOUT);
if (env.FAKE_YTDLP_STDOUT_FILE) process.stdout.write(fs.readFileSync(env.FAKE_YTDLP_STDOUT_FILE));
if (failing && env.FAKE_YTDLP_STDERR) process.stderr.write(env.FAKE_YTDLP_STDERR);

setTimeout(() => {
  if (home && exit === 0) {
    const title = env.FAKE_YTDLP_TITLE ?? "Fake video";
    const ext = valueAfter("--merge-output-format") ?? valueAfter("--audio-format") ?? "webm";
    const stem = path.join(home, `${title} [${videoId}]`);
    fs.mkdirSync(home, { recursive: true });
    const info = { id: videoId, title, formats: [{ url: "https://example.invalid/expiring" }], ...JSON.parse(env.FAKE_YTDLP_INFO ?? "{}") };
    fs.writeFileSync(`${stem}.info.json`, JSON.stringify(info));
    fs.writeFileSync(`${stem}.${ext}`, "media");
    fs.rmSync(path.join(temp, `${videoId}.part`), { force: true });
  }
  // exitCode rather than process.exit(): exiting outright cuts off stdout still queued for a pipe.
  process.exitCode = exit;
}, sleep);
