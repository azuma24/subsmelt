import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// config.ts and transcription-history.ts read these at import, so point them at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-naming-"));
const mediaDir = path.join(root, "media");
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = mediaDir;
fs.mkdirSync(path.join(mediaDir, "show"), { recursive: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { getAllSettings } = await import("../config.js");
const { runTranscriptionAttempt } = await import("./transcription-runtime.js");
const { transcriptionHistory } = await import("../transcription-history.js");

/** A shared-filesystem backend: it writes the transcript beside the video, as "auto" names it, and reports `detected`. */
async function backend(detected: string) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/preflight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, safe: true }));
      return;
    }
    const body = JSON.parse(raw) as { input_path: string; language?: string };
    // The backend names a set language with the code it was given ("Movie.en.srt"), "auto" with none.
    const { language } = body as { language?: string };
    const written = body.input_path.replace(/\.mkv$/, language && language !== "auto" ? `.${language}.srt` : ".srt");
    fs.writeFileSync(written, "1\n00:00:01,000 --> 00:00:02,000\nhello\n", "utf8");
    const result = { type: "result", ok: true, subtitle_path: written, language: detected, segments: 1 };
    res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(`${JSON.stringify(result)}\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function settingsFor(url: string, language = "auto"): Record<string, string> {
  return {
    ...getAllSettings(),
    transcription_enabled: "1",
    transcription_backend_url: url,
    transcription_transport: "shared",
    transcription_model: "small",
    transcription_language: language,
  };
}

test("an auto-detected transcript is named with the language it was detected as", async () => {
  const video = path.join(mediaDir, "show", "Talk.mkv");
  fs.writeFileSync(video, "video");
  const run = await runTranscriptionAttempt({ videoPath: video, postAction: "transcribe_only", settings: settingsFor(await backend("en")) });

  assert.equal(run.outputPath, path.join(mediaDir, "show", "Talk.eng.srt"));
  assert.ok(fs.existsSync(run.outputPath));
  assert.ok(!fs.existsSync(path.join(mediaDir, "show", "Talk.srt")));
  assert.equal(transcriptionHistory.get(run.attemptId)?.outputPath, run.outputPath);
});

test("a detected language is written with its three-letter code, never a two-letter or locale form", async () => {
  const video = path.join(mediaDir, "show", "Seoul.mkv");
  fs.writeFileSync(video, "video");
  const run = await runTranscriptionAttempt({ videoPath: video, postAction: "transcribe_only", settings: settingsFor(await backend("ko-KR")) });
  assert.equal(path.basename(run.outputPath), "Seoul.kor.srt");
});

test("an existing subtitle in the detected language is never overwritten: the transcript keeps its plain name", async () => {
  const video = path.join(mediaDir, "show", "Kept.mkv");
  fs.writeFileSync(video, "video");
  fs.writeFileSync(path.join(mediaDir, "show", "Kept.eng.srt"), "the user's own subtitle");
  const run = await runTranscriptionAttempt({ videoPath: video, postAction: "transcribe_only", settings: settingsFor(await backend("en")) });

  assert.equal(run.outputPath, path.join(mediaDir, "show", "Kept.srt"));
  assert.equal(fs.readFileSync(path.join(mediaDir, "show", "Kept.eng.srt"), "utf8"), "the user's own subtitle");
});

test("a transcript with a set language is renamed to its three-letter code", async () => {
  const video = path.join(mediaDir, "show", "Fixed.mkv");
  fs.writeFileSync(video, "video");
  const run = await runTranscriptionAttempt({ videoPath: video, postAction: "transcribe_only", settings: settingsFor(await backend("en"), "en") });
  assert.equal(path.basename(run.outputPath), "Fixed.eng.srt");
  assert.ok(!fs.existsSync(path.join(mediaDir, "show", "Fixed.en.srt")));
});

test("a confirmed overwrite replaces the transcript already there under the standard name", async () => {
  const video = path.join(mediaDir, "show", "Redo.mkv");
  fs.writeFileSync(video, "video");
  fs.writeFileSync(path.join(mediaDir, "show", "Redo.eng.srt"), "the old transcript");
  const run = await runTranscriptionAttempt({ videoPath: video, postAction: "transcribe_only", overwrite: true, settings: settingsFor(await backend("en")) });

  assert.equal(run.outputPath, path.join(mediaDir, "show", "Redo.eng.srt"));
  assert.match(fs.readFileSync(run.outputPath, "utf8"), /hello/);
  assert.ok(!fs.existsSync(path.join(mediaDir, "show", "Redo.srt")), "no duplicate left beside it");
});

/** An upload backend: it returns the transcript as content and reports `detected`. */
async function uploadBackend(detected: string) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain the upload */ }
    const result = { type: "result", ok: true, content: "1\n00:00:01,000 --> 00:00:02,000\nhello\n", language: detected, segments: 1 };
    res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(`${JSON.stringify(result)}\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("an upload run with a confirmed overwrite replaces the transcript under the standard name", async () => {
  const video = path.join(mediaDir, "show", "UpRedo.mkv");
  fs.writeFileSync(video, "video");
  fs.writeFileSync(path.join(mediaDir, "show", "UpRedo.eng.srt"), "the old transcript");
  const settings = { ...settingsFor(await uploadBackend("en")), transcription_transport: "upload" };
  const run = await runTranscriptionAttempt({ videoPath: video, postAction: "transcribe_only", overwrite: true, settings });

  assert.equal(run.outputPath, path.join(mediaDir, "show", "UpRedo.eng.srt"));
  assert.match(fs.readFileSync(run.outputPath, "utf8"), /hello/);
  assert.ok(!fs.existsSync(path.join(mediaDir, "show", "UpRedo.srt")));
});

test("a detected language that is not a plain code never reaches the file name", async () => {
  const video = path.join(mediaDir, "show", "Evil.mkv");
  fs.writeFileSync(video, "video");
  const settings = { ...settingsFor(await uploadBackend("x/../../evil")), transcription_transport: "upload" };
  const run = await runTranscriptionAttempt({ videoPath: video, postAction: "transcribe_only", settings });

  assert.equal(run.outputPath, path.join(mediaDir, "show", "Evil.srt"));
  assert.ok(!fs.existsSync(path.join(mediaDir, "evil.srt")));
  assert.ok(!fs.existsSync(path.join(root, "evil.srt")));
});

test("a run cancelled before it reached the backend never holds translation back", async () => {
  const { setSetting } = await import("../config.js");
  const { currentTranslationGate } = await import("../gpu-gate.js");
  setSetting("gpu_shared", "1");
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(500).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const video = path.join(mediaDir, "show", "Gone.mkv");
  fs.writeFileSync(video, "video");
  const caller = new AbortController();
  caller.abort();
  try {
    await assert.rejects(runTranscriptionAttempt({ videoPath: video, postAction: "transcribe_only", settings: { ...settingsFor(url), gpu_shared: "1" }, signal: caller.signal }));
    assert.equal(requests, 0);
    assert.equal(currentTranslationGate().open, true);
  } finally {
    setSetting("gpu_shared", "0");
    server.close();
  }
});
