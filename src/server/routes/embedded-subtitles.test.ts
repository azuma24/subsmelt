import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import type { EmbeddedSubtitleProbe } from "../../shared/embedded-subtitles.js";

const root = mkdtempSync(path.join(os.tmpdir(), "subsmelt-embedded-"));
const mediaDir = path.join(root, "media");
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = mediaDir;
mkdirSync(mediaDir);
const { registerEmbeddedSubtitleRoutes } = await import("./embedded-subtitles.js");
const { scanFolder } = await import("../scanner.js");
const { cuesOf, parseSubtitle } = await import("../translator/convert.js");

const app = express();
app.use(express.json());
registerEmbeddedSubtitleRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/library/embedded-subtitles`;
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  rmSync(root, { recursive: true, force: true });
});

const list = (videoPath: string) => fetch(`${url}?${new URLSearchParams({ videoPath })}`);
const importTrack = (videoPath: string, index: number, revision: string) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoPath, index, revision }),
  });

const binaryAvailable = ["ffmpeg", "ffprobe"].every((tool) => spawnSync(tool, ["-version"]).status === 0);
const requireFfmpeg = { skip: !binaryAvailable && "FFmpeg and FFprobe are required for media fixtures" };
const runFfmpeg = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", ...args]);
const srt = (text: string) => `1\n00:00:01,000 --> 00:00:03,000\n${text}\n\n`;

async function tracksFor(videoPath: string): Promise<EmbeddedSubtitleProbe> {
  const response = await list(videoPath);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function cueText(file: string) {
  return cuesOf(parseSubtitle(readFileSync(file, "utf8"), path.extname(file).slice(1).toLowerCase())).map(
    (cue) => cue.data?.text,
  );
}

test("rejects non-video paths, escaped symlinks and invalid stream indices", async () => {
  const outside = path.join(root, "Outside.mkv");
  const escaped = path.join(mediaDir, "Escaped.mkv");
  const localSrt = path.join(mediaDir, "Not video.srt");
  writeFileSync(outside, "");
  writeFileSync(localSrt, srt("subtitle"));
  symlinkSync(outside, escaped);
  for (const file of [outside, escaped, localSrt, "https://example.test/movie.mp4"]) {
    assert.equal((await list(file)).status, 400, file);
    assert.equal((await importTrack(file, 0, "old")).status, 400, file);
  }
  assert.equal((await importTrack(path.join(mediaDir, "Any.mkv"), -1, "old")).status, 400);
});

test("imports only the selected MKV stream and makes it available to the Library", requireFfmpeg, async () => {
  const full = path.join(root, "Full.srt");
  const forced = path.join(root, "Forced.srt");
  const video = path.join(mediaDir, "Movie.MKV");
  writeFileSync(full, srt("<i>Full dialogue</i>"));
  writeFileSync(forced, srt("Signs only"));
  runFfmpeg([
    "-i",
    full,
    "-i",
    forced,
    "-map",
    "0:s",
    "-map",
    "1:s",
    "-c:s",
    "copy",
    "-metadata:s:s:0",
    "language=eng",
    "-metadata:s:s:0",
    "title=Full dialogue",
    "-disposition:s:0",
    "default",
    "-metadata:s:s:1",
    "language=eng",
    "-metadata:s:s:1",
    "title=Signs",
    "-disposition:s:1",
    "forced",
    video,
  ]);
  const { revision, tracks } = await tracksFor(video);
  assert.deepEqual(tracks, [
    {
      index: 0,
      codec: "subrip",
      language: "eng",
      title: "Full dialogue",
      isDefault: true,
      isForced: false,
      isBitmap: false,
      format: "srt",
    },
    {
      index: 1,
      codec: "subrip",
      language: "eng",
      title: "Signs",
      isDefault: false,
      isForced: true,
      isBitmap: false,
      format: "srt",
    },
  ]);
  assert.equal((await importTrack(video, 99, revision)).status, 400);
  assert.equal((await importTrack(video, 1, "previous-version")).status, 412);
  const imported = await importTrack(video, 1, revision);
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { file: "Movie.eng.forced.srt" });
  assert.deepEqual(cueText(path.join(mediaDir, "Movie.eng.forced.srt")), ["Signs only"]);
  const scan = await scanFolder(false);
  const scanned = scan.files.find((file) => file.videoPath === video);
  assert.deepEqual(
    scanned?.subtitles.map((subtitle) => subtitle.srtName),
    ["Movie.eng.forced.srt"],
  );

  const responses = await Promise.all([importTrack(video, 0, revision), importTrack(video, 0, revision)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.deepEqual(cueText(path.join(mediaDir, "Movie.eng.srt")), ["<i>Full dialogue</i>"]);
  assert.ok(!readdirSync(mediaDir).some((file) => file.startsWith(".subsmelt-import-")));
});

test("converts MP4 timed text and refuses a case-variant sidecar conflict", requireFfmpeg, async () => {
  const text = path.join(root, "Timed text.srt");
  const video = path.join(mediaDir, "Timed text.mp4");
  const original = path.join(mediaDir, "Timed text.SRT");
  writeFileSync(text, srt("<i>Timed text</i>"));
  runFfmpeg(["-i", text, "-map", "0:s", "-c:s", "mov_text", video]);
  const { revision, tracks } = await tracksFor(video);
  assert.equal(tracks[0]?.codec, "mov_text");
  assert.equal(tracks[0]?.language, null);
  writeFileSync(original, srt("Keep this caption"));
  assert.equal((await importTrack(video, tracks[0].index, revision)).status, 409);
  assert.deepEqual(cueText(original), ["Keep this caption"]);
  rmSync(original);
  assert.equal((await importTrack(video, tracks[0].index, revision)).status, 200);
  assert.deepEqual(cueText(path.join(mediaDir, "Timed text.srt")), ["<i>Timed text</i>"]);
});
