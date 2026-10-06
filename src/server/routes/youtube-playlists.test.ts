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
      { posted: "2026-09-30", added: null, durationS: 148, kind: null },
      { posted: "2025-06-30", added: null, durationS: 5798, kind: null },
    ],
  });
});

test("a channel link previews and follows the channel's uploads", async () => {
  const listing = process.env.FAKE_YTDLP_STDOUT;
  process.env.FAKE_YTDLP_STDOUT = JSON.stringify({
    id: "UUXuqSBlHAE6Xw-yeJA0Tunw",
    channel_id: "UCXuqSBlHAE6Xw-yeJA0Tunw",
    title: "Uploads from Linus Tech Tips",
    channel: "Linus Tech Tips",
    availability: "public",
    playlist_count: 1,
    entries: [{ id: "uXspbC2srEQ", title: "A video", duration: 600, timestamp: ts("2026-09-30") }],
  });
  try {
    const preview = await call("POST", "/api/youtube/playlists/preview", { url: "https://www.youtube.com/@LinusTechTips", kind: "channel" });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.id, "UUXuqSBlHAE6Xw-yeJA0Tunw");
    assert.equal(preview.body.title, "Linus Tech Tips");
    assert.equal(preview.body.folder, "Linus Tech Tips");
    // The fake lists the same video as a video, a Short and a live stream; it is kept once, as a video.
    assert.deepEqual(preview.body.entries.map((e: { kind: string }) => e.kind), ["video"]);

    const followed = await call("POST", "/api/youtube/playlists", { url: preview.body.id, title: preview.body.title, backfill: { kind: "none" } });
    assert.equal(followed.status, 201);
    assert.equal(followed.body.id, "UUXuqSBlHAE6Xw-yeJA0Tunw");
    await call("DELETE", "/api/youtube/playlists/UUXuqSBlHAE6Xw-yeJA0Tunw");
  } finally {
    process.env.FAKE_YTDLP_STDOUT = listing;
  }
});

test("a channel preview rejects a playlist link, and a playlist preview a channel link", async () => {
  const channel = await call("POST", "/api/youtube/playlists/preview", { url: `https://youtube.com/playlist?list=${PL}`, kind: "channel" });
  assert.equal(channel.status, 400);
  assert.equal(channel.body.error, "Paste a link to a YouTube channel");
  const playlist = await call("POST", "/api/youtube/playlists/preview", { url: "https://www.youtube.com/@LinusTechTips" });
  assert.equal(playlist.status, 400);
  assert.equal(playlist.body.error, "Paste a link to a YouTube playlist");
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
  assert.deepEqual(summary.counts, { total: 3, removed: 0, byStatus: { skipped: 2, unavailable: 1 }, byKind: {} });
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

test("row actions move a video by the action table and refuse the rest", async () => {
  const skip = await call("POST", "/api/youtube/videos/uXspbC2srEQ/skip");
  assert.deepEqual([skip.status, skip.body.status, skip.body.skip_kind], [200, "skipped", "user"]);
  const download = await call("POST", "/api/youtube/videos/uXspbC2srEQ/download");
  assert.deepEqual([download.status, download.body.status, typeof download.body.user_queued_at], [200, "queued", "string"]);
  assert.deepEqual(await call("POST", "/api/youtube/videos/uXspbC2srEQ/retry"), {
    status: 409,
    body: { error: "Video uXspbC2srEQ cannot move from queued to queued" },
  });
  assert.deepEqual(await call("POST", "/api/youtube/videos/uXspbC2srEQ/delete"), { status: 404, body: { error: "Unknown action" } });
  assert.deepEqual(await call("POST", "/api/youtube/videos/not-a-video/skip"), { status: 404, body: { error: "Unknown video" } });
});

test("cookies are stored with mode 0600 and only their presence is ever reported", async () => {
  const bad = await call("PUT", "/api/youtube/cookies", { content: "hello" });
  assert.deepEqual(bad, { status: 400, body: { error: "This is not a cookies.txt file in Netscape format" } });

  const jar = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsecret-session\n";
  const put = await call("PUT", "/api/youtube/cookies", { content: jar });
  assert.equal(put.status, 200);
  assert.equal(put.body.present, true);
  const file = path.join(root, "data", "youtube", "cookies.txt");
  assert.equal(fs.readFileSync(file, "utf8"), jar);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const status = (await call("GET", "/api/youtube/status")).body;
  assert.deepEqual(Object.keys(status.cookies), ["present", "updatedAt"]);
  assert.equal(JSON.stringify(status).includes("secret-session"), false);
  assert.equal(status.cooldown, null);

  assert.deepEqual(await call("DELETE", "/api/youtube/cookies"), { status: 200, body: { present: false, updatedAt: null } });
  assert.equal(fs.existsSync(file), false);
});

test("the download folder setting must stay inside the media folder", async () => {
  const escape = await call("POST", "/api/settings", { youtube_download_dir: "../outside" });
  assert.deepEqual(escape, { status: 400, body: { error: "The YouTube download folder must be a folder inside the media folder" } });
  const tidy = await call("POST", "/api/settings", { youtube_download_dir: " Videos//YouTube/ " });
  assert.deepEqual(tidy.body, { ok: true, rejected: [] });
  assert.equal((await call("GET", "/api/settings")).body.youtube_download_dir, "Videos/YouTube");
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

test("following again while the old check still runs syncs with the new settings", async (t) => {
  process.env.FAKE_YTDLP_SLEEP_MS = "300";
  t.after(() => { delete process.env.FAKE_YTDLP_SLEEP_MS; });
  assert.equal((await call("POST", "/api/youtube/playlists", { url: PL, title: "AI", backfill: { kind: "none" } })).status, 201);
  assert.equal((await call("DELETE", `/api/youtube/playlists/${PL}`)).status, 200);
  assert.equal((await call("POST", "/api/youtube/playlists", { url: PL, title: "AI", backfill: { kind: "all" } })).status, 201);

  assert.equal((await call("POST", `/api/youtube/playlists/${PL}/sync`)).status, 200);
  assert.deepEqual(await videoStatuses(), [
    ["uXspbC2srEQ", "queued", null],
    ["LKsEieYbUz4", "unavailable", null],
    ["qN6OM1IzjIE", "queued", null],
  ]);
});

test("the pipeline status says when a shared GPU holds translation and when transcription has no backend", async (t) => {
  const { createJob } = await import("../db.js");
  const { setYoutubeBacklogSource } = await import("../gpu-gate.js");
  t.after(() => {
    setSetting("gpu_shared", "0");
    setYoutubeBacklogSource(() => 0);
  });
  assert.deepEqual(await call("GET", "/api/youtube/pipeline"), {
    status: 200,
    body: { gpu: { shared: false, held: false, waitingFor: 0, translationRunning: false }, transcription: { ready: false, waiting: 0 } },
  });

  setSetting("gpu_shared", "1");
  setYoutubeBacklogSource(() => 3);
  createJob({ task_id: 1, srt_path: path.join(root, "media", "a.en.srt"), output_path: path.join(root, "media", "a.eng.srt"), video_path: null });
  assert.deepEqual((await call("GET", "/api/youtube/pipeline")).body.gpu, { shared: true, held: true, waitingFor: 3, translationRunning: false });
});

test("downloading several picked videos at once moves the ones that can go and counts the rest", async () => {
  // Left out by the backfill, the way picking starts.
  store.setStatus("qN6OM1IzjIE", "skipped", { skipKind: "before_start", now: new Date().toISOString() });
  const batch = await call("POST", `/api/youtube/playlists/${PL}/videos/download`, { videoIds: ["qN6OM1IzjIE", "LKsEieYbUz4", "zzzzzzzzzzz"] });
  assert.deepEqual(batch, { status: 200, body: { downloaded: 1, refused: 2 } });
  assert.deepEqual((await videoStatuses())[2], ["qN6OM1IzjIE", "queued", null]);
  assert.equal((await call("POST", `/api/youtube/playlists/${PL}/videos/download`, { videoIds: "qN6OM1IzjIE" })).status, 400);
});
