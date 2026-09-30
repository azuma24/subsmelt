import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { YoutubeStore } from "./store.js";
import { changeBackfill, listPlaylistWithYtdlp, parseFlatListing, syncPlaylist, type FlatListing, type SyncDeps } from "./sync.js";
import type { YoutubePlaylist } from "./playlists.js";

const FAKE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-yt-dlp.mjs");
const PL = "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8";
const NOW = new Date("2026-09-30T10:00:00.000Z");
const LATER = new Date("2026-09-30T11:00:00.000Z");

const ts = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

// Shape of real `yt-dlp -J --flat-playlist` output, trimmed to the fields sync reads.
function listingJson(entries: object[], playlistCount = entries.length): string {
  return JSON.stringify({
    id: PL,
    title: "AI",
    availability: "unlisted",
    channel: "Richard",
    playlist_count: playlistCount,
    entries,
  });
}

const DOTS = { id: "uXspbC2srEQ", title: "Introducing dots", channel: "OpenAI", duration: 148, timestamp: ts("2026-09-30") };
const PRIME = { id: "BHPDsGVciDk", title: "Best AI Release of 2026", channel: "The PrimeTime", duration: 727, timestamp: ts("2026-09-26") };
const OLD = { id: "qN6OM1IzjIE", title: "Teaching in the Age of AI", channel: "Jane Street", duration: 5798, timestamp: ts("2026-07-30") };
const PRIVATE = { id: "LKsEieYbUz4", title: "[Private video]", duration: null };

const playlist = (overrides: Partial<YoutubePlaylist> = {}): YoutubePlaylist => ({
  id: PL,
  title: "AI",
  folder: "AI",
  enabled: true,
  mode: "auto",
  backfill: { kind: "none" },
  media: { type: "audio", format: "m4a" },
  captions: "prefer_youtube",
  subtitleTaskIds: [],
  checkEveryMinutes: 60,
  ...overrides,
});

function deps(listings: FlatListing[], overrides: Partial<SyncDeps> = {}): SyncDeps {
  let call = 0;
  return {
    listPlaylist: async () => listings[Math.min(call++, listings.length - 1)],
    exactUploadDate: async () => null,
    addedDates: async () => null,
    now: () => NOW,
    ...overrides,
  };
}

const statuses = (store: YoutubeStore) =>
  store.playlistVideos(PL).map((v) => [v.video_id, v.status, v.skip_kind, v.removed_at === null ? "listed" : "removed"]);

test("parseFlatListing reads ids, rounded dates, and private placeholders", () => {
  const listing = parseFlatListing(listingJson([DOTS, PRIVATE, { id: "not-a-video-id" }], 3));
  assert.equal(listing.title, "AI");
  assert.equal(listing.availability, "unlisted");
  assert.equal(listing.playlistCount, 3);
  assert.deepEqual(listing.entries, [
    { videoId: "uXspbC2srEQ", title: "Introducing dots", channel: "OpenAI", durationS: 148, publishedAt: "2026-09-30", position: 1 },
    { videoId: "LKsEieYbUz4", title: null, channel: null, durationS: null, publishedAt: null, position: 2 },
  ]);
});

test("listPlaylistWithYtdlp runs the flat listing on the canonical URL and surfaces the ERROR line", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-sync-"));
  const argvFile = path.join(dir, "argv.jsonl");
  process.env.SUBSMELT_YTDLP_BIN = FAKE_BIN;
  process.env.FAKE_YTDLP_ARGV_FILE = argvFile;
  process.env.FAKE_YTDLP_STDOUT = listingJson([DOTS]);
  t.after(() => {
    for (const name of ["SUBSMELT_YTDLP_BIN", "FAKE_YTDLP_ARGV_FILE", "FAKE_YTDLP_STDOUT", "FAKE_YTDLP_STDERR", "FAKE_YTDLP_EXIT"]) delete process.env[name];
  });

  const listing = await listPlaylistWithYtdlp(PL);
  assert.deepEqual(listing.entries.map((e) => e.videoId), ["uXspbC2srEQ"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8").trim()), [
    "-J", "--flat-playlist", "--js-runtimes", "node", "--extractor-args", "youtubetab:approximate_date", "--",
    `https://www.youtube.com/playlist?list=${PL}`,
  ]);

  process.env.FAKE_YTDLP_STDOUT = "";
  process.env.FAKE_YTDLP_STDERR = "WARNING: something\nERROR: [youtube:tab] PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8: The playlist does not exist\n";
  process.env.FAKE_YTDLP_EXIT = "1";
  await assert.rejects(listPlaylistWithYtdlp(PL), { message: "ERROR: [youtube:tab] PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8: The playlist does not exist" });
});

test("listPlaylistWithYtdlp parses a listing larger than a megabyte", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-sync-big-"));
  const file = path.join(dir, "listing.json");
  const entries = Array.from({ length: 3000 }, (_, i) => ({
    id: `v${String(i).padStart(10, "0")}`,
    title: `Video ${i}`,
    duration: 60,
    thumbnails: [{ url: `https://i.ytimg.com/vi/${i}/hqdefault.jpg?sqp=${"x".repeat(300)}` }],
  }));
  fs.writeFileSync(file, listingJson(entries));
  assert.ok(fs.statSync(file).size > 1_000_000);
  process.env.SUBSMELT_YTDLP_BIN = FAKE_BIN;
  process.env.FAKE_YTDLP_STDOUT_FILE = file;
  t.after(() => {
    delete process.env.SUBSMELT_YTDLP_BIN;
    delete process.env.FAKE_YTDLP_STDOUT_FILE;
  });

  const listing = await listPlaylistWithYtdlp(PL);
  assert.equal(listing.entries.length, 3000);
  assert.equal(listing.entries[2999].videoId, "v0000002999");
});

test("first sync with backfill None skips what is already there; private entries become unavailable", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const result = await syncPlaylist(store, playlist(), deps([parseFlatListing(listingJson([DOTS, PRIVATE, PRIME]))]));

  assert.deepEqual(result, { title: "AI", total: 3, added: 3, removed: 0, restored: 0 });
  assert.deepEqual(statuses(store), [
    ["uXspbC2srEQ", "skipped", "before_start", "listed"],
    ["LKsEieYbUz4", "unavailable", null, "listed"],
    ["BHPDsGVciDk", "skipped", "before_start", "listed"],
  ]);
  assert.deepEqual(store.getSyncState(PL), {
    lastCheckedAt: NOW.toISOString(), lastError: null, count: 3, availability: "unlisted", firstSyncAt: NOW.toISOString(),
  });
});

test("later syncs queue new videos in auto mode and mark them new in manual mode", async () => {
  const first = parseFlatListing(listingJson([PRIME]));
  const second = parseFlatListing(listingJson([DOTS, PRIME]));

  const auto = new YoutubeStore(new Database(":memory:"));
  await syncPlaylist(auto, playlist(), deps([first]));
  await syncPlaylist(auto, playlist(), deps([second], { now: () => LATER }));
  assert.deepEqual(statuses(auto), [
    ["uXspbC2srEQ", "queued", null, "listed"],
    ["BHPDsGVciDk", "skipped", "before_start", "listed"],
  ]);

  const manual = new YoutubeStore(new Database(":memory:"));
  await syncPlaylist(manual, playlist({ mode: "manual" }), deps([first]));
  await syncPlaylist(manual, playlist({ mode: "manual" }), deps([second], { now: () => LATER }));
  assert.equal(manual.getVideo("uXspbC2srEQ")?.status, "new");
});

test("removal is marked only when the listing count matches playlist_count", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  await syncPlaylist(store, playlist({ backfill: { kind: "all" } }), deps([parseFlatListing(listingJson([DOTS, PRIME]))]));

  const short = await syncPlaylist(store, playlist(), deps([parseFlatListing(listingJson([DOTS], 2))], { now: () => LATER }));
  assert.equal(short.removed, 0);

  const complete = await syncPlaylist(store, playlist(), deps([parseFlatListing(listingJson([DOTS], 1))], { now: () => LATER }));
  assert.equal(complete.removed, 1);
  assert.deepEqual(statuses(store), [
    ["uXspbC2srEQ", "queued", null, "listed"],
    ["BHPDsGVciDk", "queued", null, "removed"],
  ]);
});

test("a failed listing records the error and leaves the videos alone", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const failing = deps([], { listPlaylist: async () => { throw new Error("ERROR: HTTP Error 429: Too Many Requests"); } });
  await assert.rejects(syncPlaylist(store, playlist(), failing), /HTTP Error 429/);
  assert.deepEqual(store.getSyncState(PL), {
    lastCheckedAt: NOW.toISOString(), lastError: "ERROR: HTTP Error 429: Too Many Requests", count: null, availability: null, firstSyncAt: null,
  });
});

test("first sync with Added since stores added dates and fails without them", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const listing = parseFlatListing(listingJson([DOTS, OLD]));
  const added = new Map([["uXspbC2srEQ", "2026-09-30"], ["qN6OM1IzjIE", "2026-09-15"]]);
  await syncPlaylist(store, playlist({ backfill: { kind: "added_since", date: "2026-09-10" } }), deps([listing], { addedDates: async () => added }));
  assert.deepEqual(store.playlistVideos(PL).map((v) => [v.video_id, v.status, v.added_at]), [
    ["uXspbC2srEQ", "queued", "2026-09-30"],
    ["qN6OM1IzjIE", "queued", "2026-09-15"],
  ]);

  const other = new YoutubeStore(new Database(":memory:"));
  await assert.rejects(
    syncPlaylist(other, playlist({ backfill: { kind: "added_since", date: "2026-09-10" } }), deps([listing], { addedDates: async () => { throw new Error("API key not valid"); } })),
    /API key not valid/,
  );
  assert.equal(other.playlistVideos(PL).length, 0);
});

test("changing the backfill releases filtered videos and never touches user skips", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  await syncPlaylist(store, playlist(), deps([parseFlatListing(listingJson([DOTS, PRIME, OLD]))]));
  store.setStatus("uXspbC2srEQ", "queued", { now: LATER.toISOString() });
  store.setStatus("uXspbC2srEQ", "skipped", { skipKind: "user", now: LATER.toISOString() });

  const change = await changeBackfill(store, playlist(), { kind: "posted_since", date: "2026-09-01" }, deps([]));
  assert.deepEqual(change, { kept: 0, released: 1, skipped: 0 });
  assert.deepEqual(statuses(store), [
    ["uXspbC2srEQ", "skipped", "user", "listed"],
    ["BHPDsGVciDk", "queued", null, "listed"],
    ["qN6OM1IzjIE", "skipped", "before_start", "listed"],
  ]);

  const back = await changeBackfill(store, playlist(), { kind: "none" }, deps([]));
  assert.deepEqual(back, { kept: 0, released: 0, skipped: 1 });
  assert.equal(store.getVideo("BHPDsGVciDk")?.status, "skipped");
});

test("following again re-applies the new backfill to videos still waiting or filtered out", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const listing = parseFlatListing(listingJson([DOTS, PRIME]));
  await syncPlaylist(store, playlist(), deps([listing]));
  store.setStatus("BHPDsGVciDk", "queued", { now: LATER.toISOString() });
  store.setStatus("BHPDsGVciDk", "skipped", { skipKind: "user", now: LATER.toISOString() });

  store.deleteSyncState(PL);
  await syncPlaylist(store, playlist({ backfill: { kind: "all" } }), deps([listing], { now: () => LATER }));
  assert.deepEqual(statuses(store), [
    ["uXspbC2srEQ", "queued", null, "listed"],
    ["BHPDsGVciDk", "skipped", "user", "listed"],
  ]);
});
