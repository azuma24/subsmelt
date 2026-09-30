#!/usr/bin/env node
// Test double for yt-dlp. Behaviour comes from environment variables:
// FAKE_YTDLP_ARGV_FILE   append this run's argv as one JSON line
// FAKE_YTDLP_VERSION     printed for --version (default 2026.08.19)
// FAKE_YTDLP_STDOUT      written to stdout, one line per \n
// FAKE_YTDLP_STDERR      written to stderr
// FAKE_YTDLP_EXIT        exit code (default 0)
// FAKE_YTDLP_SLEEP_MS    wait before exiting
import fs from "node:fs";

const args = process.argv.slice(2);
const env = process.env;
if (env.FAKE_YTDLP_ARGV_FILE) fs.appendFileSync(env.FAKE_YTDLP_ARGV_FILE, `${JSON.stringify(args)}\n`);

if (args.includes("--version")) {
  process.stdout.write(`${env.FAKE_YTDLP_VERSION ?? "2026.08.19"}\n`);
  process.exit(0);
}
if (env.FAKE_YTDLP_STDOUT) process.stdout.write(env.FAKE_YTDLP_STDOUT);
if (env.FAKE_YTDLP_STDERR) process.stderr.write(env.FAKE_YTDLP_STDERR);
const exit = Number(env.FAKE_YTDLP_EXIT ?? 0);
const sleep = Number(env.FAKE_YTDLP_SLEEP_MS ?? 0);
setTimeout(() => process.exit(exit), sleep);
