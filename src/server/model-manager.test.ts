import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  listBackendModels,
  deleteBackendModel,
  downloadBackendModel,
} from "./transcription-client.js";

// Minimal fetch stub helpers. We swap the global fetch per test and restore it.
type FetchFn = typeof fetch;
const originalFetch = globalThis.fetch;

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Builds a streaming Response whose body yields the given NDJSON lines as
// Uint8Array chunks — matching a real fetch() body, which the consumer decodes.
function ndjsonResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const chunks = lines.map((l) => encoder.encode(`${l}\n`));
  const stream = Readable.toWeb(Readable.from(chunks)) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, { status });
}

test("listBackendModels parses the models array and forwards the auth header", async () => {
  let seenAuth: string | null = null;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seenAuth = new Headers(init?.headers).get("Authorization");
    assert.equal(String(url), "http://backend:8001/models");
    return jsonResponse({ models: [{ id: "small", downloaded: true, sizeMb: 466 }] });
  }) as FetchFn;

  try {
    const models = await listBackendModels("http://backend:8001/", "secret");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "small");
    assert.equal(models[0].downloaded, true);
    assert.equal(seenAuth, "Bearer secret");
  } finally {
    restoreFetch();
  }
});

test("listBackendModels tolerates a missing models field", async () => {
  globalThis.fetch = (async () => jsonResponse({})) as FetchFn;
  try {
    assert.deepEqual(await listBackendModels("http://backend:8001"), []);
  } finally {
    restoreFetch();
  }
});

test("listBackendModels maps a 401 to the token-rejected message", async () => {
  globalThis.fetch = (async () => jsonResponse({ error: "nope" }, 401)) as FetchFn;
  try {
    await assert.rejects(() => listBackendModels("http://backend:8001"), /token/i);
  } finally {
    restoreFetch();
  }
});

test("deleteBackendModel returns the freedMb result and url-encodes the model", async () => {
  let seenUrl = "";
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    assert.equal(init?.method, "DELETE");
    return jsonResponse({ ok: true, freedMb: 466 });
  }) as FetchFn;
  try {
    const result = await deleteBackendModel("http://backend:8001", "large-v3", "tok");
    assert.equal(result.ok, true);
    assert.equal(result.freedMb, 466);
    assert.equal(seenUrl, "http://backend:8001/models/large-v3");
  } finally {
    restoreFetch();
  }
});

test("downloadBackendModel relays progress lines and resolves with the terminal result", async () => {
  const progress: number[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), "http://backend:8001/models/download");
    assert.equal(JSON.parse(String(init?.body)).model, "small");
    return ndjsonResponse([
      JSON.stringify({ type: "progress", pct: 10, downloadedMb: 46, totalMb: 466 }),
      JSON.stringify({ type: "progress", pct: 80, downloadedMb: 372, totalMb: 466 }),
      JSON.stringify({ type: "result", ok: true, model: "small", cachePath: "/cache/small" }),
    ]);
  }) as FetchFn;

  try {
    const result = await downloadBackendModel("http://backend:8001", "small", {
      onProgress: (u) => progress.push(u.pct),
    });
    assert.deepEqual(progress, [10, 80]);
    assert.equal(result.ok, true);
    assert.equal(result.model, "small");
    assert.equal(result.cachePath, "/cache/small");
  } finally {
    restoreFetch();
  }
});

test("downloadBackendModel throws when the stream emits an error line", async () => {
  globalThis.fetch = (async () =>
    ndjsonResponse([
      JSON.stringify({ type: "progress", pct: 5 }),
      JSON.stringify({ type: "error", error: "disk full" }),
    ])) as FetchFn;
  try {
    await assert.rejects(() => downloadBackendModel("http://backend:8001", "medium"), /disk full/);
  } finally {
    restoreFetch();
  }
});

test("downloadBackendModel throws when the stream ends without a result", async () => {
  globalThis.fetch = (async () =>
    ndjsonResponse([JSON.stringify({ type: "progress", pct: 50 })])) as FetchFn;
  try {
    await assert.rejects(() => downloadBackendModel("http://backend:8001", "tiny"), /without a result/);
  } finally {
    restoreFetch();
  }
});
