import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// config.ts, db.ts and scanner.ts read these at import, so point them at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-cancel-"));
const mediaDir = path.join(root, "media");
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = mediaDir;
fs.mkdirSync(path.join(mediaDir, "show"), { recursive: true });

const { default: express } = await import("express");
const { setSettings } = await import("../config.js");
const { registerTranscriptionRoutes } = await import("./transcription.js");

// Long enough that a cancel sent after the backend sees the request always lands first.
const BACKEND_ANSWER_DELAY_MS = 1000;

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

async function post(route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${appUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// A Whisper backend that answers `slowRoute` only after a delay and 404s every
// other transcribe route, so path and upload runs take the non-streaming fallback.
// `expectedArrivals` lets a test wait for several concurrent runs to land.
async function startBackend(slowRoute: string, answer: string, expectedArrivals = 1) {
  let markReceived!: () => void;
  let markClosed!: (hungUp: boolean) => void;
  const received = new Promise<void>((resolve) => {
    let arrivals = 0;
    markReceived = () => {
      arrivals += 1;
      if (arrivals >= expectedArrivals) resolve();
    };
  });
  const clientHungUp = new Promise<boolean>((resolve) => {
    markClosed = resolve;
  });
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/preflight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, safe: true }));
      return;
    }
    if (req.url !== slowRoute) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ detail: "Not Found" }));
      return;
    }
    markReceived();
    const timer = setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(answer);
    }, BACKEND_ANSWER_DELAY_MS);
    res.on("close", () => {
      clearTimeout(timer);
      markClosed(!res.writableEnded);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    clientHungUp,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("a URL transcription is cancelled by the URL it was started with", async () => {
  const backend = await startBackend(
    "/transcribe/url/stream",
    `${JSON.stringify({ type: "result", ok: true, content: "hello", language: "en", segments: 1 })}\n`,
  );
  setSettings({ transcription_enabled: "1", transcription_backend_url: backend.url });
  try {
    const url = "https://example.com/watch?v=abc";
    const run = post("/api/transcribe/url", { url });
    await backend.received;

    assert.deepEqual(await post("/api/transcribe/cancel", { path: url }), { status: 200, body: { ok: true } });
    assert.deepEqual(await run, { status: 400, body: { error: "Transcription cancelled" } });
    assert.equal(await backend.clientHungUp, true);
  } finally {
    backend.close();
  }
});

test("cancelling a shared-filesystem run on a backend without the stream route aborts the fallback request", async () => {
  const backend = await startBackend(
    "/transcribe",
    JSON.stringify({ ok: true, subtitle_path: "/srv/show/a.srt", language: "en", segments: 1 }),
  );
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
  });
  const videoPath = path.join(mediaDir, "show", "a.mkv");
  fs.writeFileSync(videoPath, "video", "utf8");
  try {
    const run = post("/api/transcribe", { videoPath });
    await backend.received;

    assert.deepEqual(await post("/api/transcribe/cancel", { path: videoPath }), { status: 200, body: { ok: true } });
    assert.deepEqual(await run, { status: 400, body: { error: "Transcription cancelled" } });
    assert.equal(await backend.clientHungUp, true);
  } finally {
    backend.close();
  }
});

test("cancelling an upload run on a backend without the stream route writes no subtitle", async () => {
  const backend = await startBackend(
    "/transcribe/upload",
    JSON.stringify({ ok: true, content: "1\n00:00:00,000 --> 00:00:01,000\nhello\n", language: "en", segments: 1 }),
  );
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "upload",
  });
  const videoPath = path.join(mediaDir, "show", "b.mkv");
  fs.writeFileSync(videoPath, "video", "utf8");
  try {
    const run = post("/api/transcribe", { videoPath });
    await backend.received;

    assert.deepEqual(await post("/api/transcribe/cancel", { path: videoPath }), { status: 200, body: { ok: true } });
    assert.deepEqual(await run, { status: 400, body: { error: "Transcription cancelled" } });
    assert.equal(await backend.clientHungUp, true);
    assert.equal(fs.existsSync(path.join(mediaDir, "show", "b.srt")), false);
  } finally {
    backend.close();
  }
});

test("cancel-all stops every in-flight transcription", async () => {
  const backend = await startBackend(
    "/transcribe",
    JSON.stringify({ ok: true, subtitle_path: "/srv/show/x.srt", language: "en", segments: 1 }),
    2,
  );
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
    transcription_max_concurrent: "2",
  });
  const first = path.join(mediaDir, "show", "c.mkv");
  const second = path.join(mediaDir, "show", "d.mkv");
  fs.writeFileSync(first, "video", "utf8");
  fs.writeFileSync(second, "video", "utf8");
  try {
    const runA = post("/api/transcribe", { videoPath: first });
    const runB = post("/api/transcribe", { videoPath: second });
    await backend.received;

    assert.deepEqual(await post("/api/transcribe/cancel-all", {}), { status: 200, body: { ok: true, cancelled: 2 } });
    const results = await Promise.all([runA, runB]);
    for (const result of results) {
      assert.deepEqual(result, { status: 400, body: { error: "Transcription cancelled" } });
    }
  } finally {
    backend.close();
  }
});

test("a client that hangs up mid-run cancels the transcription", async () => {
  const backend = await startBackend(
    "/transcribe",
    JSON.stringify({ ok: true, subtitle_path: "/srv/show/e.srt", language: "en", segments: 1 }),
  );
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
  });
  const videoPath = path.join(mediaDir, "show", "e.mkv");
  fs.writeFileSync(videoPath, "video", "utf8");
  try {
    const client = new AbortController();
    const run = fetch(`${appUrl}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoPath }),
      signal: client.signal,
    });
    await backend.received;
    client.abort();

    await assert.rejects(run);
    // The hangup must reach the backend as a closed connection, not leave it transcribing.
    assert.equal(await backend.clientHungUp, true);
  } finally {
    backend.close();
  }
});

test("a second run of a file already transcribing is refused, and the first stays cancellable", async () => {
  const backend = await startBackend(
    "/transcribe",
    JSON.stringify({ ok: true, subtitle_path: "/srv/show/f.srt", language: "en", segments: 1 }),
  );
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
    transcription_max_concurrent: "2",
  });
  const videoPath = path.join(mediaDir, "show", "f.mkv");
  fs.writeFileSync(videoPath, "video", "utf8");
  try {
    const first = post("/api/transcribe", { videoPath });
    await backend.received;

    const second = await post("/api/transcribe", { videoPath });
    assert.equal(second.status, 409);
    assert.match((second.body as { error: string }).error, /already running/);

    assert.deepEqual(await post("/api/transcribe/cancel", { path: videoPath }), { status: 200, body: { ok: true } });
    assert.deepEqual(await first, { status: 400, body: { error: "Transcription cancelled" } });
  } finally {
    backend.close();
  }
});

test("a scan does not claim a video that is already transcribing", async () => {
  const { claimAutoTranscriptions, releaseAutoTranscription } = await import("../auto-transcription.js");
  const { beginTranscriptionRun, endTranscriptionRun } = await import("../transcription/in-flight.js");
  const running = path.join(mediaDir, "show", "g.mkv");
  const idle = path.join(mediaDir, "show", "h.mkv");
  const controller = beginTranscriptionRun(running);
  try {
    assert.deepEqual(claimAutoTranscriptions([running, idle]), [idle]);
  } finally {
    endTranscriptionRun(running, controller);
    releaseAutoTranscription(idle);
  }
});
