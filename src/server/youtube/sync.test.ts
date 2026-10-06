import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { YoutubeStore } from "./store.js";
import { changeBackfill, changeChannelContent, exactUploadDateWithYtdlp, listChannelUploads, listPlaylistWithYtdlp, parseFlatListing, resolveChannelWithYtdlp, syncPlaylist, type FlatListing, type SyncDeps } from "./sync.js";
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
  include: { shorts: false, live: false },
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

test("a listing larger than the capture limit is an error, never a cut-off document", async (t) => {
  process.env.SUBSMELT_YTDLP_BIN = FAKE_BIN;
  process.env.FAKE_YTDLP_STDOUT = listingJson([DOTS, PRIME, OLD]);
  t.after(() => {
    delete process.env.SUBSMELT_YTDLP_BIN;
    delete process.env.FAKE_YTDLP_STDOUT;
  });
  await assert.rejects(listPlaylistWithYtdlp(PL, { maxBytes: 200 }), { message: "The playlist listing is larger than 200 bytes" });
  assert.equal((await listPlaylistWithYtdlp(PL, { maxBytes: 10_000 })).entries.length, 3);
});

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

test("a private placeholder that later lists as a real video is released like a newly listed one", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  await syncPlaylist(store, playlist({ backfill: { kind: "all" } }), deps([parseFlatListing(listingJson([DOTS, PRIVATE]))]));
  assert.equal(store.getVideo(PRIVATE.id)?.status, "unavailable");

  const nowPublic = { ...PRIVATE, title: "Now public", duration: 300, timestamp: ts("2026-09-29") };
  const result = await syncPlaylist(store, playlist(), deps([parseFlatListing(listingJson([DOTS, nowPublic]))], { now: () => LATER }));
  assert.equal(result.added, 0);
  assert.deepEqual([store.getVideo(PRIVATE.id)?.status, store.getVideo(PRIVATE.id)?.title], ["queued", "Now public"]);

  const manual = new YoutubeStore(new Database(":memory:"));
  await syncPlaylist(manual, playlist({ mode: "manual" }), deps([parseFlatListing(listingJson([PRIVATE]))]));
  await syncPlaylist(manual, playlist({ mode: "manual" }), deps([parseFlatListing(listingJson([nowPublic]))], { now: () => LATER }));
  assert.equal(manual.getVideo(PRIVATE.id)?.status, "new");
});

test("a sync requeues videos YouTube's soft session limit marked unavailable, but not ones a download found gone", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  await syncPlaylist(store, playlist({ backfill: { kind: "all" } }), deps([parseFlatListing(listingJson([DOTS, PRIME]))]));
  const marked = (id: string, reason: string) => {
    store.setStatus(id, "downloading", { now: NOW.toISOString() });
    store.setStatus(id, "unavailable", { now: NOW.toISOString(), reason });
  };
  marked(DOTS.id, "ERROR: [youtube] uXspbC2srEQ: Video unavailable. This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.");
  marked(PRIME.id, "ERROR: [youtube] BHPDsGVciDk: Video unavailable. The uploader has not made this video available in your country");

  await syncPlaylist(store, playlist(), deps([parseFlatListing(listingJson([DOTS, PRIME]))], { now: () => LATER }));
  assert.deepEqual([DOTS.id, PRIME.id].map((id) => [store.getVideo(id)?.status, store.getVideo(id)?.reason === null]), [
    ["queued", true],
    ["unavailable", false],
  ]);
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

test("a filter change releases skipped videos to new on a manual playlist and never re-skips a video the user queued", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const manual = playlist({ mode: "manual", backfill: { kind: "none" } });
  await syncPlaylist(store, manual, deps([parseFlatListing(listingJson([DOTS, PRIME, OLD]))]));
  store.applyUserAction("qN6OM1IzjIE", "download", LATER.toISOString());

  const change = await changeBackfill(store, manual, { kind: "posted_since", date: "2026-09-01" }, deps([]));
  assert.deepEqual(change, { kept: 0, released: 2, skipped: 0 });
  const back = await changeBackfill(store, manual, { kind: "none" }, deps([]));
  assert.deepEqual(back, { kept: 0, released: 0, skipped: 2 });
  await changeBackfill(store, manual, { kind: "all" }, deps([]));
  assert.deepEqual(statuses(store), [
    ["uXspbC2srEQ", "new", null, "listed"],
    ["BHPDsGVciDk", "new", null, "listed"],
    ["qN6OM1IzjIE", "queued", null, "listed"],
  ]);
});

test("a followed channel keeps its own name, not the uploads playlist's", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const uploads = "UUXuqSBlHAE6Xw-yeJA0Tunw";
  const listing = { ...parseFlatListing(listingJson([DOTS])), id: uploads, title: "Uploads from Linus Tech Tips", channel: "Linus Tech Tips" };
  const result = await syncPlaylist(store, playlist({ id: uploads, title: "Linus Tech Tips" }), deps([listing]));
  assert.equal(result.title, "Linus Tech Tips");
});

const UPLOADS = "UUXuqSBlHAE6Xw-yeJA0Tunw";
const SHORT = { id: "zH9bqwNShiM", title: "A short", channel: "LTT", duration: 40, timestamp: ts("2026-09-20") };
const LIVE = { id: "Z1sqWFs86uU", title: "WAN Show", channel: "LTT", duration: 9000, timestamp: ts("2026-09-25") };

function subList(id: string, entries: object[]): FlatListing {
  return { ...parseFlatListing(listingJson(entries)), id, title: id, channel: "Linus Tech Tips" };
}

/** Lists each sub-list by its prefix; a missing one fails the way YouTube reports it. */
function channelLists(lists: Record<string, object[] | null>) {
  return async (id: string): Promise<FlatListing> => {
    const entries = lists[id.slice(0, 4)];
    if (!entries) throw new Error(`ERROR: [youtube:tab] ${id}: YouTube said: The playlist does not exist.`);
    return subList(id, entries);
  };
}

test("a channel is listed as its videos, Shorts and live streams, each tagged; a missing list is empty", async () => {
  const listing = await listChannelUploads(UPLOADS, channelLists({ UULF: [DOTS, PRIME], UUSH: [SHORT], UULV: null }));
  assert.equal(listing.id, UPLOADS);
  assert.equal(listing.channel, "Linus Tech Tips");
  assert.equal(listing.playlistCount, 3);
  assert.deepEqual(listing.entries.map((e) => [e.videoId, e.contentKind]), [
    ["uXspbC2srEQ", "video"],
    ["BHPDsGVciDk", "video"],
    ["zH9bqwNShiM", "short"],
  ]);
});

test("a channel listing failure other than a missing list is an error", async () => {
  const listOne = async (id: string): Promise<FlatListing> => {
    if (id.startsWith("UUSH")) throw new Error("ERROR: Sign in to confirm you are not a bot");
    return subList(id, [DOTS]);
  };
  await assert.rejects(listChannelUploads(UPLOADS, listOne), /not a bot/);
});

const channel = (overrides: Partial<YoutubePlaylist> = {}) =>
  playlist({ id: UPLOADS, title: "Linus Tech Tips", backfill: { kind: "all" }, include: { shorts: false, live: false }, ...overrides });

async function channelListing(): Promise<FlatListing> {
  return listChannelUploads(UPLOADS, channelLists({ UULF: [DOTS], UUSH: [SHORT], UULV: [LIVE] }));
}

const channelStatuses = (store: YoutubeStore) =>
  Object.fromEntries(store.playlistVideos(UPLOADS).map((v) => [v.video_id, [v.status, v.skip_kind]]));

test("Shorts and live streams a channel leaves out are skipped as content, whatever the backfill", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  await syncPlaylist(store, channel(), deps([await channelListing()]));
  assert.deepEqual(channelStatuses(store), {
    uXspbC2srEQ: ["queued", null],
    zH9bqwNShiM: ["skipped", "content"],
    Z1sqWFs86uU: ["skipped", "content"],
  });
});

test("turning Shorts on applies the backfill to them; turning them off skips the untouched ones again", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  await syncPlaylist(store, channel(), deps([await channelListing()]));

  const on = await changeChannelContent(store, channel(), { shorts: true, live: false }, deps([]));
  assert.deepEqual(on, { released: 1, skipped: 0 });
  assert.deepEqual(channelStatuses(store).zH9bqwNShiM, ["queued", null]);
  assert.deepEqual(channelStatuses(store).Z1sqWFs86uU, ["skipped", "content"]);

  const off = await changeChannelContent(store, channel({ include: { shorts: true, live: false } }), { shorts: false, live: false }, deps([]));
  assert.deepEqual(off, { released: 0, skipped: 1 });
  assert.deepEqual(channelStatuses(store).zH9bqwNShiM, ["skipped", "content"]);
});

test("turning live streams on with backfill None leaves the old ones skipped before the start", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const none = channel({ backfill: { kind: "none" } });
  await syncPlaylist(store, none, deps([await channelListing()]));
  const on = await changeChannelContent(store, none, { shorts: false, live: true }, deps([]));
  assert.deepEqual(on, { released: 0, skipped: 0 });
  assert.deepEqual(channelStatuses(store).Z1sqWFs86uU, ["skipped", "before_start"]);
});

test("a channel never scans its uploads for added dates, which equal the upload dates", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  let scans = 0;
  await syncPlaylist(store, channel(), deps([await channelListing()], { addedDates: async () => { scans += 1; return new Map(); } }));
  assert.equal(scans, 0);
});

test("an exact-date lookup refused by YouTube's soft session limit throws, so the lane cools down", async (t) => {
  process.env.SUBSMELT_YTDLP_BIN = FAKE_BIN;
  process.env.FAKE_YTDLP_STDERR = "ERROR: [youtube] uXspbC2srEQ: Video unavailable. This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.\n";
  process.env.FAKE_YTDLP_EXIT = "1";
  t.after(() => {
    for (const name of ["SUBSMELT_YTDLP_BIN", "FAKE_YTDLP_STDERR", "FAKE_YTDLP_EXIT"]) delete process.env[name];
  });
  await assert.rejects(exactUploadDateWithYtdlp("uXspbC2srEQ"), /session has been rate-limited/);
});

const undated = (id: string, contentKind: "video" | "short" | "live", position: number) =>
  ({ videoId: id, contentKind, title: `Upload ${id}`, channel: "Chan", durationS: 60, publishedAt: null, position });

test("posted-since never looks up the date of a kind the follow leaves out", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const listing: FlatListing = {
    id: PL, title: "Chan", channel: "Chan", availability: "public", playlistCount: 3,
    entries: [undated("aaaaaaaaaaa", "video", 1), undated("bbbbbbbbbbb", "short", 2), undated("ccccccccccc", "live", 3)],
  };
  const asked: string[] = [];
  await syncPlaylist(store, playlist({ backfill: { kind: "posted_since", date: "2026-09-01" } }), deps([listing], {
    exactUploadDate: async (id) => { asked.push(id); return "2026-09-10"; },
  }));
  assert.deepEqual(asked, ["aaaaaaaaaaa"]);
  assert.deepEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map((id) => [store.getVideo(id)!.status, store.getVideo(id)!.skip_kind]), [
    ["queued", null],
    ["skipped", "content"],
    ["skipped", "content"],
  ]);
});

test("a first sync cut short by YouTube keeps the dates it found, and the retry looks up only the rest", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const listing = parseFlatListing(listingJson([
    { id: "aaaaaaaaaaa", title: "One", duration: 60 },
    { id: "bbbbbbbbbbb", title: "Two", duration: 60 },
    { id: "ccccccccccc", title: "Three", duration: 60 },
  ]));
  const posted = playlist({ backfill: { kind: "posted_since", date: "2026-09-01" } });
  const asked: string[] = [];
  const lookup = (failOn: string | null) => async (id: string) => {
    asked.push(id);
    if (id === failOn) throw new Error("ERROR: HTTP Error 429: Too Many Requests");
    return id === "bbbbbbbbbbb" ? "2026-08-01" : "2026-09-10";
  };

  await assert.rejects(syncPlaylist(store, posted, deps([listing], { exactUploadDate: lookup("ccccccccccc") })), /429/);
  assert.equal(store.getSyncState(PL).firstSyncAt, null);
  await syncPlaylist(store, posted, deps([listing], { exactUploadDate: lookup(null), now: () => LATER }));

  assert.deepEqual(asked, ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ccccccccccc"]);
  assert.deepEqual(store.playlistVideos(PL).map((v) => [v.video_id, v.status, v.published_at]), [
    ["aaaaaaaaaaa", "queued", "2026-09-10"],
    ["bbbbbbbbbbb", "skipped", "2026-08-01"],
    ["ccccccccccc", "queued", "2026-09-10"],
  ]);
});

test("listings, channel lookups and date lookups pass a private copy of the uploaded cookies", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-sync-cookies-"));
  const argvFile = path.join(dir, "argv.jsonl");
  const before = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(dir, "data");
  process.env.SUBSMELT_YTDLP_BIN = FAKE_BIN;
  process.env.FAKE_YTDLP_ARGV_FILE = argvFile;
  t.after(() => {
    for (const name of ["SUBSMELT_YTDLP_BIN", "FAKE_YTDLP_ARGV_FILE", "FAKE_YTDLP_STDOUT"]) delete process.env[name];
    if (before === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = before;
  });
  fs.mkdirSync(path.join(dir, "data", "youtube"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "youtube", "cookies.txt"), ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx\n");

  process.env.FAKE_YTDLP_STDOUT = listingJson([DOTS]);
  await listPlaylistWithYtdlp(PL);
  process.env.FAKE_YTDLP_STDOUT = JSON.stringify({ channel_id: "UCsBjURrPoezykLs9EqgamOA" });
  await resolveChannelWithYtdlp({ url: "https://www.youtube.com/@Fireship" });
  process.env.FAKE_YTDLP_STDOUT = "20260930\n";
  assert.equal(await exactUploadDateWithYtdlp("uXspbC2srEQ"), "2026-09-30");

  const runs = fs.readFileSync(argvFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.equal(runs.length, 3);
  for (const args of runs) {
    const jar = args[args.indexOf("--cookies") + 1];
    assert.ok(args.indexOf("--cookies") >= 0 && args.indexOf("--cookies") < args.indexOf("--"), args.join(" "));
    assert.equal(path.basename(jar), "cookies.txt");
    assert.ok(jar.startsWith(path.join(dir, "data", "youtube", "tmp")), jar);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, "data", "youtube", "tmp")), [], "every copy is removed after its run");
});

test("a check applies the follow's settings as saved when it finishes, not as they were when it began", async () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const first: FlatListing = { id: PL, title: "Chan", channel: "Chan", availability: "public", playlistCount: 1, entries: [undated("aaaaaaaaaaa", "video", 1)] };
  await syncPlaylist(store, playlist({ include: { shorts: true, live: true } }), deps([first]));

  // Shorts and live were turned off while the listing ran.
  const second: FlatListing = { ...first, playlistCount: 3, entries: [...first.entries, undated("bbbbbbbbbbb", "short", 2), undated("ccccccccccc", "live", 3)] };
  const saved = playlist({ include: { shorts: false, live: false }, mode: "manual" });
  await syncPlaylist(store, playlist({ include: { shorts: true, live: true } }), deps([second], { now: () => LATER, currentPlaylist: () => saved }));

  assert.deepEqual(["bbbbbbbbbbb", "ccccccccccc"].map((id) => [store.getVideo(id)!.status, store.getVideo(id)!.skip_kind]), [
    ["skipped", "content"],
    ["skipped", "content"],
  ]);
});
