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
const { transcriptionWork } = await import("../transcription/work.js");

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

async function queueWork(kind: "file" | "url", input: string): Promise<string> {
  const queued = await post("/api/transcribe/work", { inputs: [{ kind, input, request: {} }] });
  assert.equal(queued.status, 202);
  return (queued.body as { items: Array<{ id: string }> }).items[0].id;
}

async function workStatus(id: string): Promise<string> {
  return (await fetch(`${appUrl}/api/transcribe/work/${id}`).then((res) => res.json())).status;
}

test("cancelling queued URL work aborts the backend stream", async () => {
  const backend = await startBackend(
    "/transcribe/url/stream",
    `${JSON.stringify({ type: "result", ok: true, content: "hello", language: "en", segments: 1 })}\n`,
  );
  setSettings({ transcription_enabled: "1", transcription_backend_url: backend.url });
  try {
    const id = await queueWork("url", "https://example.com/watch?v=abc");
    await backend.received;

    assert.deepEqual(await post(`/api/transcribe/work/${id}/cancel`, {}), { status: 200, body: { ok: true } });
    await transcriptionWork.idle();
    assert.equal(await workStatus(id), "cancelled");
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
    const id = await queueWork("file", videoPath);
    await backend.received;

    assert.deepEqual(await post("/api/transcribe/cancel", { path: videoPath }), { status: 200, body: { ok: true } });
    await transcriptionWork.idle();
    assert.equal(await workStatus(id), "cancelled");
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
    const id = await queueWork("file", videoPath);
    await backend.received;

    assert.deepEqual(await post(`/api/transcribe/work/${id}/cancel`, {}), { status: 200, body: { ok: true } });
    await transcriptionWork.idle();
    assert.equal(await workStatus(id), "cancelled");
    assert.equal(await backend.clientHungUp, true);
    assert.equal(fs.existsSync(path.join(mediaDir, "show", "b.srt")), false);
  } finally {
    backend.close();
  }
});

test("cancel-all stops the running work and the work queued behind it", async () => {
  const backend = await startBackend(
    "/transcribe",
    JSON.stringify({ ok: true, subtitle_path: "/srv/show/x.srt", language: "en", segments: 1 }),
  );
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
  });
  const first = path.join(mediaDir, "show", "c.mkv");
  const second = path.join(mediaDir, "show", "d.mkv");
  fs.writeFileSync(first, "video", "utf8");
  fs.writeFileSync(second, "video", "utf8");
  try {
    const queued = await post("/api/transcribe/work", {
      inputs: [
        { kind: "file", input: first, request: {} },
        { kind: "file", input: second, request: {} },
      ],
    });
    const ids = (queued.body as { items: Array<{ id: string }> }).items.map((item) => item.id);
    await backend.received;

    assert.deepEqual(await post("/api/transcribe/cancel-all", {}), { status: 200, body: { ok: true, cancelled: 2 } });
    await transcriptionWork.idle();
    assert.deepEqual(await Promise.all(ids.map(workStatus)), ["cancelled", "cancelled"]);
  } finally {
    backend.close();
  }
});

test("queueing a file already queued returns the existing work, which stays cancellable", async () => {
  const backend = await startBackend(
    "/transcribe",
    JSON.stringify({ ok: true, subtitle_path: "/srv/show/f.srt", language: "en", segments: 1 }),
  );
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
  });
  const videoPath = path.join(mediaDir, "show", "f.mkv");
  fs.writeFileSync(videoPath, "video", "utf8");
  try {
    const id = await queueWork("file", videoPath);
    await backend.received;

    assert.equal(await queueWork("file", videoPath), id);

    assert.deepEqual(await post("/api/transcribe/cancel", { path: videoPath }), { status: 200, body: { ok: true } });
    await transcriptionWork.idle();
    assert.equal(await workStatus(id), "cancelled");
  } finally {
    backend.close();
  }
});

test("queued URL work survives browser disconnect and exposes its completed output", async () => {
  const backend = await startBackend(
    "/transcribe/url/stream",
    `${JSON.stringify({ type: "result", ok: true, content: "hello", language: "en", segments: 1 })}\n`,
  );
  setSettings({ transcription_enabled: "1", transcription_backend_url: backend.url });
  try {
    const url = "https://example.org/video";
    const queued = await post("/api/transcribe/work", { inputs: [{ kind: "url", input: url, request: {} }] });
    assert.equal(queued.status, 202);
    const id = (queued.body as { items: Array<{ id: string }> }).items[0].id;
    await backend.received;
    // The submitting response is already closed; no browser remains waiting.
    const duplicate = await post("/api/transcribe/work", { inputs: [{ kind: "url", input: url, request: {} }] });
    assert.equal((duplicate.body as { items: Array<{ id: string }> }).items[0].id, id);
    assert.equal(await backend.clientHungUp, false);
    const result = await fetch(`${appUrl}/api/transcribe/work/${id}`).then((res) => res.json());
    assert.equal(result.status, "succeeded");
    assert.equal(result.content, "hello");
    assert.equal(result.request, undefined);
    const listed = await fetch(`${appUrl}/api/transcribe/work`).then((res) => res.json());
    const row = listed.items.find((item: { id: string }) => item.id === id);
    assert.equal(row.content, undefined);
    assert.equal(row.request, undefined);
  } finally {
    backend.close();
  }
});
