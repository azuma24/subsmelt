import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// config.ts, scanner.ts and transcription/work.ts read these at import, so point them at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-retry-"));
const mediaDir = path.join(root, "media");
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = mediaDir;
fs.mkdirSync(path.join(mediaDir, "show"), { recursive: true });

const videoPath = path.join(mediaDir, "show", "Episode 01.mkv");
fs.writeFileSync(videoPath, "video", "utf8");
const secondVideoPath = path.join(mediaDir, "show", "Episode 02.mkv");
fs.writeFileSync(secondVideoPath, "video", "utf8");

const { default: express } = await import("express");
const { setSettings } = await import("../config.js");
const { registerTranscriptionRoutes } = await import("./transcription.js");
const { transcriptionWork } = await import("../transcription/work.js");

const app = express();
app.use(express.json());
registerTranscriptionRoutes(app);
const appServer = app.listen(0, "127.0.0.1");
await once(appServer, "listening");
const appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
after(() => {
  appServer.closeAllConnections();
  appServer.close();
});

// A backend that records each transcribe request body and answers with a finished subtitle.
async function startBackend(subtitlePath: string) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/preflight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, safe: true }));
      return;
    }
    bodies.push(JSON.parse(raw));
    const result = { type: "result", ok: true, subtitle_path: subtitlePath, language: "en", segments: 3 };
    res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(`${JSON.stringify(result)}\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// The Transcribe page retries a history attempt by queueing this request.
async function queueRetry(input: string, request: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${appUrl}/api/transcribe/work`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: [{ kind: "file", input, request }] }),
  });
  assert.equal(res.status, 202);
  const id = ((await res.json()) as { items: Array<{ id: string }> }).items[0].id;
  await transcriptionWork.idle();
  return id;
}

test("a retry reuses the attempt's model and language, not the current defaults", async () => {
  const backend = await startBackend("/srv/show/Episode 01.ja.srt");
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
    transcription_model: "small",
    transcription_language: "en",
  });
  try {
    await queueRetry(videoPath, {
      postAction: "transcribe_only",
      outputFormat: "srt",
      model: "nemotron-3.5-asr",
      language: "ja",
    });
    assert.deepEqual(
      backend.bodies.map(({ model, language }) => ({ model, language })),
      [{ model: "nemotron-3.5-asr", language: "ja" }],
    );
  } finally {
    backend.close();
  }
});

test("a retry replays the attempt's device, compute type, format and advanced options", async () => {
  const backend = await startBackend("/srv/show/Episode 02.vtt");
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
    transcription_device: "cpu",
    transcription_compute_type: "int8",
    transcription_advanced_stt: JSON.stringify({ beam_size: 1 }),
  });
  try {
    await queueRetry(secondVideoPath, {
      postAction: "transcribe_only",
      outputFormat: "vtt",
      model: "large-v3",
      language: "auto",
      device: "cuda",
      computeType: "float16",
      advancedOptions: { beam_size: 8, speaker_diarization: true },
    });
    assert.deepEqual(
      backend.bodies.map(({ model, device, compute_type, output_format, advanced_options }) => ({
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
    backend.close();
  }
});
