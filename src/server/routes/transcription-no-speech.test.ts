import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// config.ts and transcription-history.ts read these at import, so point them at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-no-speech-"));
const mediaDir = path.join(root, "media");
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = mediaDir;
fs.mkdirSync(path.join(mediaDir, "show"), { recursive: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { getAllSettings } = await import("../config.js");
const { runTranscriptionAttempt, transcriptionErrorStatus } = await import("./transcription-runtime.js");
const { noSpeechVideos, transcriptionHistory } = await import("../transcription-history.js");

type Reply = { written?: string | null; content?: string; segments: number };

/** A backend that answers every run with `reply`; in shared mode it writes `written` beside the video (null: no file). */
async function backend(reply: () => Reply) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/preflight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, safe: true }));
      return;
    }
    const { written, content, segments } = reply();
    let subtitlePath: string | undefined;
    if (req.url === "/transcribe/stream" && written !== null && written !== undefined) {
      const { input_path } = JSON.parse(raw) as { input_path: string };
      subtitlePath = input_path.replace(/\.mkv$/, ".srt");
      fs.writeFileSync(subtitlePath, written, "utf8");
    }
    const result = { type: "result", ok: true, subtitle_path: subtitlePath, content, language: "en", segments };
    res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(`${JSON.stringify(result)}\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function settingsFor(url: string, transport: "shared" | "upload"): Record<string, string> {
  return {
    ...getAllSettings(),
    transcription_enabled: "1",
    transcription_backend_url: url,
    transcription_transport: transport,
    transcription_language: "auto",
  };
}

function video(name: string): string {
  const videoPath = path.join(mediaDir, "show", `${name}.mkv`);
  fs.writeFileSync(videoPath, "video");
  return videoPath;
}

async function noSpeechRun(videoPath: string, settings: Record<string, string>) {
  let caught: unknown;
  await runTranscriptionAttempt({ videoPath, postAction: "transcribe_and_translate", settings }).catch((error) => { caught = error; });
  assert.ok(caught instanceof Error, "the run must fail");
  assert.equal(caught.message, "No speech found");
  assert.equal(transcriptionErrorStatus(caught), 422);
  const [attempt] = transcriptionHistory.listRecent(1);
  assert.equal(attempt.inputPath, videoPath);
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.errorSummary, "No speech found");
  assert.equal(noSpeechVideos.has(videoPath), true, "scans skip it from now on");
}

test("shared mode: an empty transcript for zero segments is deleted and the run is no speech, not a success", async () => {
  const videoPath = video("Silent");
  await noSpeechRun(videoPath, settingsFor(await backend(() => ({ written: "", segments: 0 })), "shared"));
  assert.equal(fs.existsSync(path.join(mediaDir, "show", "Silent.srt")), false);
});

test("shared mode: zero segments with no file written is no speech too", async () => {
  const videoPath = video("Music");
  await noSpeechRun(videoPath, settingsFor(await backend(() => ({ written: null, segments: 0 })), "shared"));
});

test("upload mode: empty content writes no file", async () => {
  const videoPath = video("Quiet");
  await noSpeechRun(videoPath, settingsFor(await backend(() => ({ content: "", segments: 0 })), "upload"));
  assert.deepEqual(fs.readdirSync(path.join(mediaDir, "show")).filter((name) => name.startsWith("Quiet.") && name !== "Quiet.mkv"), []);
});

test("a later run that finds speech takes the video off the no-speech list", async () => {
  const videoPath = video("Later");
  let reply: Reply = { content: "", segments: 0 };
  const settings = settingsFor(await backend(() => reply), "upload");
  await noSpeechRun(videoPath, settings);

  reply = { content: "1\n00:00:01,000 --> 00:00:02,000\nhello\n", segments: 1 };
  const run = await runTranscriptionAttempt({ videoPath, postAction: "transcribe_only", settings });
  assert.equal(transcriptionHistory.get(run.attemptId)?.status, "succeeded");
  assert.equal(noSpeechVideos.has(videoPath), false);
});

test("a silent video replaced on disk is transcribed again by scans", () => {
  const videoPath = video("Replaced");
  noSpeechVideos.mark(videoPath);
  assert.equal(noSpeechVideos.has(videoPath), true);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(videoPath, later, later);
  assert.equal(noSpeechVideos.has(videoPath), false);
});
