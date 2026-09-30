import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";

// config.ts reads CONFIG_DIR at import; the sync shells out to the fake yt-dlp.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-yt-routes-"));
process.env.CONFIG_DIR = path.join(root, "config");
process.env.DATA_DIR = path.join(root, "data");
process.env.MEDIA_DIR = path.join(root, "media");
process.env.SUBSMELT_YTDLP_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../youtube/fake-yt-dlp.mjs");

const PL = "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8";
const ts = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
process.env.FAKE_YTDLP_STDOUT = JSON.stringify({
  id: PL,
  title: "AI",
  availability: "unlisted",
  channel: "Richard",
  playlist_count: 3,
  entries: [
    { id: "uXspbC2srEQ", title: "Introducing dots", channel: "OpenAI", duration: 148, timestamp: ts("2026-09-30") },
    { id: "LKsEieYbUz4", title: "[Private video]", duration: null },
    { id: "qN6OM1IzjIE", title: "Teaching in the Age of AI", channel: "Jane Street", duration: 5798, timestamp: ts("2025-06-30") },
  ],
});

const { setSetting } = await import("../config.js");
const { registerSettingsTasksRoutes } = await import("./settings-tasks.js");
const { registerYoutubeRoutes } = await import("./youtube.js");
const { YoutubeStore } = await import("../youtube/store.js");
const { YoutubeWorker } = await import("../youtube/worker.js");

const app = express();
app.use(express.json());
registerSettingsTasksRoutes(app);
const store = new YoutubeStore(new Database(":memory:"));
// Stopped, so no download starts behind the assertions; checks still run on the lane.
const worker = new YoutubeWorker(store);
worker.stop();
registerYoutubeRoutes(app, store, worker);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const videoStatuses = async () =>
  (await call("GET", `/api/youtube/playlists/${PL}/videos`)).body.videos.map((v: { video_id: string; status: string; skip_kind: string | null }) => [
    v.video_id,
    v.status,
    v.skip_kind,
  ]);

test("preview parses a pasted share link and summarises the listing", async () => {
  const { status, body } = await call("POST", "/api/youtube/playlists/preview", {
    url: `https://youtube.com/playlist?list=${PL}&si=abc123`,
  });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    id: PL,
    title: "AI",
    channel: "Richard",
    availability: "unlisted",
    count: 3,
    unavailable: 1,
    followed: false,
    folder: "AI",
    addedDates: false,
    addedDatesError: null,
    entries: [
      { posted: "2026-09-30", added: null, durationS: 148 },
      { posted: "2025-06-30", added: null, durationS: 5798 },
    ],
  });
});

test("preview and follow reject a link without a playlist", async () => {
  const preview = await call("POST", "/api/youtube/playlists/preview", { url: "https://www.youtube.com/watch?v=uXspbC2srEQ" });
  assert.deepEqual(preview, { status: 400, body: { error: "Paste a link to a YouTube playlist" } });
  const follow = await call("POST", "/api/youtube/playlists", { url: "https://example.com/playlist?list=PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8" });
  assert.deepEqual(follow, { status: 400, body: { error: "Paste a link to a YouTube playlist" } });
});

test("Added since cannot be chosen without an API key", async () => {
  const follow = await call("POST", "/api/youtube/playlists", { url: PL, title: "AI", backfill: { kind: "added_since", date: "2026-09-01" } });
  assert.deepEqual(follow, { status: 400, body: { error: "Added since needs a YouTube Data API key in Settings" } });
});

test("following with backfill None stores every listed video without queueing old ones", async () => {
  const follow = await call("POST", "/api/youtube/playlists", {
    url: `https://www.youtube.com/playlist?list=${PL}`,
    title: "AI",
    backfill: { kind: "none" },
    media: { type: "audio", format: "m4a" },
  });
  assert.equal(follow.status, 201);
  assert.equal(follow.body.folder, "AI");

  // Joins the check the follow started.
  const sync = await call("POST", `/api/youtube/playlists/${PL}/sync`);
  assert.equal(sync.status, 200);
  assert.equal(sync.body.total, 3);

  assert.deepEqual(await videoStatuses(), [
    ["uXspbC2srEQ", "skipped", "before_start"],
    ["LKsEieYbUz4", "unavailable", null],
    ["qN6OM1IzjIE", "skipped", "before_start"],
  ]);
  const list = await call("GET", "/api/youtube/playlists");
  const [summary] = list.body.playlists;
  assert.deepEqual(summary.counts, { total: 3, removed: 0, byStatus: { skipped: 2, unavailable: 1 } });
  assert.equal(summary.sync.availability, "unlisted");
  assert.equal(summary.sync.lastError, null);
  assert.equal(summary.sync.checking, false);

  const again = await call("POST", "/api/youtube/playlists", { url: PL, title: "AI" });
  assert.deepEqual(again, { status: 409, body: { error: "This playlist is already followed" } });
});

test("changing the backfill releases the videos it now keeps", async () => {
  const change = await call("POST", `/api/youtube/playlists/${PL}/backfill`, { backfill: { kind: "posted_since", date: "2026-01-01" } });
  assert.deepEqual(change, { status: 200, body: { ok: true, kept: 0, released: 1, skipped: 0 } });
  assert.deepEqual((await videoStatuses())[0], ["uXspbC2srEQ", "queued", null]);
  const [summary] = (await call("GET", "/api/youtube/playlists")).body.playlists;
  assert.deepEqual(summary.backfill, { kind: "posted_since", date: "2026-01-01" });
});

test("editing changes settings but never the backfill", async () => {
  const edit = await call("PUT", `/api/youtube/playlists/${PL}`, { mode: "manual", checkEveryMinutes: 360, backfill: { kind: "all" } });
  assert.equal(edit.status, 200);
  assert.deepEqual([edit.body.mode, edit.body.checkEveryMinutes, edit.body.backfill], ["manual", 360, { kind: "posted_since", date: "2026-01-01" }]);
  const bad = await call("PUT", `/api/youtube/playlists/${PL}`, { media: { type: "audio", format: "mp3" } });
  assert.deepEqual(bad, { status: 400, body: { error: "media.format must be m4a or opus" } });
});

test("the Settings endpoints never expose or overwrite the playlists, and redact the API key", async () => {
  setSetting("youtube_api_key", "AIzaSecret");
  const settings = (await call("GET", "/api/settings")).body;
  assert.equal("youtube_playlists" in settings, false);
  assert.equal(settings.youtube_api_key, "__SUBSMELT_SECRET_REDACTED__");

  const save = await call("POST", "/api/settings", { youtube_playlists: "[]", youtube_download_dir: "Videos/YouTube" });
  assert.deepEqual(save.body, { ok: true, rejected: ["youtube_playlists"] });
  assert.equal((await call("GET", "/api/youtube/playlists")).body.playlists.length, 1);
  setSetting("youtube_api_key", "");
});

test("the key test checks a typed key against Google and reports its message", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "www.googleapis.com") return realFetch(input, init);
    const ok = url.searchParams.get("key") === "AIzaGood";
    return new Response(JSON.stringify(ok ? { items: [] } : { error: { message: "API key not valid. Please pass a valid API key." } }), { status: ok ? 200 : 400 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  assert.deepEqual(await call("POST", "/api/youtube/api-key/test", {}), { status: 400, body: { error: "No API key to test" } });
  assert.deepEqual(await call("POST", "/api/youtube/api-key/test", { key: "AIzaGood" }), { status: 200, body: { ok: true } });
  assert.deepEqual(await call("POST", "/api/youtube/api-key/test", { key: "AIzaBad" }), {
    status: 400,
    body: { error: "API key not valid. Please pass a valid API key." },
  });
});

test("unfollowing removes the playlist and later calls report it is not followed", async () => {
  assert.deepEqual(await call("DELETE", `/api/youtube/playlists/${PL}`), { status: 200, body: { ok: true } });
  assert.deepEqual(await call("GET", `/api/youtube/playlists/${PL}/videos`), { status: 404, body: { error: "This playlist is not followed" } });
  assert.deepEqual((await call("GET", "/api/youtube/playlists")).body, { playlists: [] });
});
