import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
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

function bitmapFixture(file: string) {
  const segment = (pts: number, type: number, hex = "") => {
    const payload = Buffer.from(hex, "hex");
    const header = Buffer.alloc(13);
    header.write("PG");
    header.writeUInt32BE(pts, 2);
    header.writeUInt32BE(pts, 6);
    header[10] = type;
    header.writeUInt16BE(payload.length, 11);
    return Buffer.concat([header, payload]);
  };
  // A four-by-two palette image in a 1080p PGS frame, followed by its clear frame.
  writeFileSync(
    file,
    Buffer.concat([
      segment(90_000, 0x16, "07800438100001800000010000000000100010"),
      segment(90_000, 0x17, "01000010001000040002"),
      segment(90_000, 0x14, "0000001080800001eb8080ff"),
      segment(90_000, 0x15, "000000c000001000040002010101010000010101010000"),
      segment(90_000, 0x80),
      segment(270_000, 0x16, "0780043810000200000000"),
      segment(270_000, 0x80),
    ]),
  );
}

test(
  "explicit OCR isolates the selected PGS/VobSub stream and validates, cancels and publishes safely",
  requireFfmpeg,
  async () => {
    const fixture = path.join(root, "bitmap.sup");
    bitmapFixture(fixture);
    const vobsub = path.join(root, "vobsub.mks");
    runFfmpeg(["-i", fixture, "-map", "0:s", "-c:s", "dvd_subtitle", "-f", "matroska", vobsub]);
    const video = path.join(mediaDir, "Bitmap.mkv");
    runFfmpeg([
      "-itsoffset",
      "3",
      "-i",
      fixture,
      "-itsoffset",
      "5",
      "-i",
      vobsub,
      "-map",
      "0:s",
      "-map",
      "1:s",
      "-c:s",
      "copy",
      "-metadata:s:s:0",
      "language=eng",
      "-metadata:s:s:1",
      "language=fra",
      video,
    ]);

    delete process.env.SUBSMELT_SECONV_PATH;
    const unsupported = await tracksFor(video);
    assert.deepEqual(
      unsupported.tracks.map((track) => track.ocr),
      ["unavailable", "unavailable"],
    );
    const helper = path.join(root, "seconv.mjs");
    const observation = path.join(root, "ocr-visit.json");
    writeFileSync(
      helper,
      `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "list-ocr-engines") {
  console.log(JSON.stringify({engines: [{id: "tesseract", ready: true}]}));
} else {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name:packet=pts_time", "-of", "json", args[0]], { encoding: "utf8" }));
  const scratch = path.dirname(args[0]);
  writeFileSync(new URL("ocr-visit.json", import.meta.url), JSON.stringify({ scratch, ...probe }));
  const mode = process.env.SUBSMELT_TEST_OCR_MODE;
  if (mode === "cancel") {
    setInterval(() => {}, 1000);
  } else {
    writeFileSync(path.join(scratch, "subtitle.srt"), mode === "invalid" ? "not an SRT" : ${JSON.stringify(srt("OCR dialogue"))});
    console.log(JSON.stringify({ success: true }));
  }
}
`,
      { mode: 0o700 },
    );
    process.env.SUBSMELT_SECONV_PATH = helper;
    const probe = await tracksFor(video);
    assert.deepEqual(
      probe.tracks.map((track) => track.ocr),
      ["available", "available"],
    );
    const importImage = (position: number, signal?: AbortSignal) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoPath: video,
          index: probe.tracks[position].index,
          revision: probe.revision,
          ocr: true,
        }),
        signal,
      });

    try {
      assert.equal((await importTrack(video, probe.tracks[0].index, probe.revision)).status, 422);
      assert.equal((await importImage(0)).status, 200);
      assert.deepEqual(cueText(path.join(mediaDir, "Bitmap.eng.srt")), ["OCR dialogue"]);
      const pgs = JSON.parse(readFileSync(observation, "utf8"));
      assert.deepEqual(pgs.streams, [{ codec_name: "hdmv_pgs_subtitle" }]);
      assert.ok(Number(pgs.packets[0].pts_time) >= 3);
      assert.equal(existsSync(pgs.scratch), false);
      assert.equal((await importImage(0)).status, 409);

      process.env.SUBSMELT_TEST_OCR_MODE = "invalid";
      assert.equal((await importImage(1)).status, 422);
      const dvd = JSON.parse(readFileSync(observation, "utf8"));
      assert.deepEqual(dvd.streams, [{ codec_name: "dvd_subtitle" }]);
      assert.equal(existsSync(dvd.scratch), false);
      assert.equal(existsSync(path.join(mediaDir, "Bitmap.fra.srt")), false);

      rmSync(observation);
      process.env.SUBSMELT_TEST_OCR_MODE = "cancel";
      const controller = new AbortController();
      const pending = importImage(1, controller.signal);
      for (let attempt = 0; attempt < 100 && !existsSync(observation); attempt++) await wait(25);
      assert.ok(existsSync(observation), "OCR subprocess should start");
      const { scratch } = JSON.parse(readFileSync(observation, "utf8"));
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      for (let attempt = 0; attempt < 100 && existsSync(scratch); attempt++) await wait(25);
      assert.equal(existsSync(scratch), false);
      assert.equal(existsSync(path.join(mediaDir, "Bitmap.fra.srt")), false);

      delete process.env.SUBSMELT_TEST_OCR_MODE;
      assert.equal((await importImage(1)).status, 200);
      assert.deepEqual(cueText(path.join(mediaDir, "Bitmap.fra.srt")), ["OCR dialogue"]);
    } finally {
      delete process.env.SUBSMELT_SECONV_PATH;
      delete process.env.SUBSMELT_TEST_OCR_MODE;
    }
  },
);
