import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// config.ts, scanner.ts and transcription-history.ts read these at import, so point them at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-retry-"));
const mediaDir = path.join(root, "media");
const dataDir = path.join(root, "data");
process.env.DATA_DIR = dataDir;
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = mediaDir;
fs.mkdirSync(path.join(mediaDir, "show"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const videoPath = path.join(mediaDir, "show", "Episode 01.mkv");
fs.writeFileSync(videoPath, "video", "utf8");
const secondVideoPath = path.join(mediaDir, "show", "Episode 02.mkv");
fs.writeFileSync(secondVideoPath, "video", "utf8");
fs.writeFileSync(
  path.join(dataDir, "transcription-history.json"),
  JSON.stringify([
    {
      id: "failed-nemotron-run",
      inputPath: videoPath,
      outputPath: path.join(mediaDir, "show", "Episode 01.ja.srt"),
      model: "nemotron-3.5-asr",
      language: "ja",
      outputFormat: "srt",
      postAction: "transcribe_only",
      status: "failed",
      startedAt: "2026-09-01T10:00:00.000Z",
      finishedAt: "2026-09-01T10:00:05.000Z",
      durationSeconds: null,
      errorSummary: "Backend unreachable",
    },
    {
      id: "failed-gpu-run",
      inputPath: secondVideoPath,
      outputPath: path.join(mediaDir, "show", "Episode 02.srt"),
      model: "large-v3",
      language: "auto",
      outputFormat: "vtt",
      postAction: "transcribe_only",
      status: "failed",
      startedAt: "2026-09-01T11:00:00.000Z",
      finishedAt: "2026-09-01T11:00:05.000Z",
      durationSeconds: null,
      errorSummary: "Backend unreachable",
      advancedOptions: { beam_size: 8, speaker_diarization: true },
      device: "cuda",
      computeType: "float16",
    },
  ]),
  "utf8",
);

const { default: express } = await import("express");
const { setSettings } = await import("../config.js");
const { registerTranscriptionHistoryRoutes } = await import("./transcription-history-routes.js");

const app = express();
app.use(express.json());
registerTranscriptionHistoryRoutes(app);
const appServer = app.listen(0, "127.0.0.1");
await once(appServer, "listening");
const appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
after(() => {
  appServer.closeAllConnections();
  appServer.close();
});

test("retrying a history attempt reuses its model and language, not the current defaults", async () => {
  const transcribeBodies: Array<{ model?: string; language?: string }> = [];
  const backend = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/preflight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, safe: true }));
      return;
    }
    transcribeBodies.push(JSON.parse(raw));
    const result = {
      type: "result",
      ok: true,
      subtitle_path: "/srv/show/Episode 01.ja.srt",
      language: "ja",
      segments: 3,
    };
    res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(`${JSON.stringify(result)}\n`);
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
    transcription_transport: "shared",
    transcription_model: "small",
    transcription_language: "en",
  });
  try {
    const res = await fetch(`${appUrl}/api/transcribe/history/failed-nemotron-run/retry`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(
      transcribeBodies.map(({ model, language }) => ({ model, language })),
      [{ model: "nemotron-3.5-asr", language: "ja" }],
    );
  } finally {
    backend.closeAllConnections();
    backend.close();
  }
});

test("retrying replays the attempt's device, compute type, format and advanced options", async () => {
  const transcribeBodies: Array<Record<string, unknown>> = [];
  const backend = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/preflight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, safe: true }));
      return;
    }
    transcribeBodies.push(JSON.parse(raw));
    const result = { type: "result", ok: true, subtitle_path: "/srv/show/Episode 02.vtt", language: "en", segments: 3 };
    res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(`${JSON.stringify(result)}\n`);
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
    transcription_transport: "shared",
    transcription_device: "cpu",
    transcription_compute_type: "int8",
    transcription_advanced_stt: JSON.stringify({ beam_size: 1 }),
  });
  try {
    const res = await fetch(`${appUrl}/api/transcribe/history/failed-gpu-run/retry`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(
      transcribeBodies.map(({ model, device, compute_type, output_format, advanced_options }) => ({
        model,
        device,
        compute_type,
        output_format,
        advanced_options,
      })),
      [
        {
          model: "large-v3",
          device: "cuda",
          compute_type: "float16",
          output_format: "vtt",
          advanced_options: { beam_size: 8, speaker_diarization: true },
        },
      ],
    );
  } finally {
    backend.closeAllConnections();
    backend.close();
  }
});
