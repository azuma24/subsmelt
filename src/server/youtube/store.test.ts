import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { IllegalTransitionError, YoutubeStore, type ListedVideo } from "./store.js";

const PL = "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8";
const T0 = "2026-09-30T10:00:00.000Z";
const T1 = "2026-09-30T11:00:00.000Z";

function listed(videoId: string, position: number, overrides: Partial<ListedVideo> = {}): ListedVideo {
  return {
    videoId,
    title: `Video ${videoId}`,
    channel: "OpenAI",
    durationS: 148,
    publishedAt: "2026-09-30",
    position,
    initial: { status: "queued" },
    ...overrides,
  };
}

const freshStore = () => new YoutubeStore(new Database(":memory:"));

test("applyListing inserts new videos with their initial status and position", () => {
  const store = freshStore();
  const result = store.applyListing(PL, [listed("uXspbC2srEQ", 1), listed("BHPDsGVciDk", 2, { initial: { status: "skipped", skipKind: "before_start" } })], { complete: true, now: T0 });

  assert.deepEqual(result, { added: 2, removed: 0, restored: 0 });
  const rows = store.playlistVideos(PL).map((v) => [v.video_id, v.status, v.skip_kind, v.position]);
  assert.deepEqual(rows, [
    ["uXspbC2srEQ", "queued", null, 1],
    ["BHPDsGVciDk", "skipped", "before_start", 2],
  ]);
});

test("a skipped tombstone keeps its status when the next sync lists it again", () => {
  const store = freshStore();
  store.applyListing(PL, [listed("uXspbC2srEQ", 1, { initial: { status: "skipped", skipKind: "user" } })], { complete: true, now: T0 });
  const again = store.applyListing(PL, [listed("uXspbC2srEQ", 1, { title: "Renamed", initial: { status: "queued" } })], { complete: true, now: T1 });

  assert.deepEqual(again, { added: 0, removed: 0, restored: 0 });
  const video = store.getVideo("uXspbC2srEQ");
  assert.equal(video?.status, "skipped");
  assert.equal(video?.title, "Renamed");
});

test("a complete listing marks missing members removed and a reappearing one restored", () => {
  const store = freshStore();
  store.applyListing(PL, [listed("uXspbC2srEQ", 1), listed("BHPDsGVciDk", 2)], { complete: true, now: T0 });

  const dropped = store.applyListing(PL, [listed("uXspbC2srEQ", 1)], { complete: true, now: T1 });
  assert.deepEqual(dropped, { added: 0, removed: 1, restored: 0 });
  assert.deepEqual(store.counts(PL), { total: 1, removed: 1, byStatus: { queued: 1 } });

  const back = store.applyListing(PL, [listed("uXspbC2srEQ", 1), listed("BHPDsGVciDk", 2)], { complete: true, now: T1 });
  assert.deepEqual(back, { added: 0, removed: 0, restored: 1 });
  assert.equal(store.playlistVideos(PL).find((v) => v.video_id === "BHPDsGVciDk")?.removed_at, null);
});

test("an incomplete listing never marks anything removed", () => {
  const store = freshStore();
  store.applyListing(PL, [listed("uXspbC2srEQ", 1), listed("BHPDsGVciDk", 2)], { complete: true, now: T0 });
  const partial = store.applyListing(PL, [listed("uXspbC2srEQ", 1)], { complete: false, now: T1 });

  assert.equal(partial.removed, 0);
  assert.deepEqual(store.counts(PL), { total: 2, removed: 0, byStatus: { queued: 2 } });
});

test("a missing title does not overwrite a known one, and exact dates survive a rounded listing", () => {
  const store = freshStore();
  store.applyListing(PL, [listed("uXspbC2srEQ", 1, { publishedAt: "2026-09-28" })], { complete: true, now: T0 });
  store.applyListing(PL, [listed("uXspbC2srEQ", 1, { title: null, durationS: null, publishedAt: "2026-08-30" })], { complete: true, now: T1 });

  const video = store.getVideo("uXspbC2srEQ");
  assert.equal(video?.title, "Video uXspbC2srEQ");
  assert.equal(video?.duration_s, 148);
  assert.equal(video?.published_at, "2026-09-28");
});

test("setStatus applies allowed moves and refuses illegal ones", () => {
  const store = freshStore();
  store.applyListing(PL, [listed("uXspbC2srEQ", 1, { initial: { status: "new" } })], { complete: true, now: T0 });

  const skipped = store.setStatus("uXspbC2srEQ", "skipped", { skipKind: "user", reason: "You skipped this", now: T1 });
  assert.deepEqual([skipped.status, skipped.skip_kind, skipped.reason, skipped.updated_at], ["skipped", "user", "You skipped this", T1]);

  assert.throws(() => store.setStatus("uXspbC2srEQ", "done", { now: T1 }), IllegalTransitionError);
  assert.equal(store.getVideo("uXspbC2srEQ")?.status, "skipped");

  const queued = store.setStatus("uXspbC2srEQ", "queued", { now: T1 });
  assert.deepEqual([queued.status, queued.skip_kind], ["queued", null]);
});

test("knownMembers reports which ids the playlist has already listed", () => {
  const store = freshStore();
  store.applyListing(PL, [listed("uXspbC2srEQ", 1)], { complete: true, now: T0 });
  assert.deepEqual([...store.knownMembers(PL, ["uXspbC2srEQ", "BHPDsGVciDk"])], ["uXspbC2srEQ"]);
});

test("sync state merges patches and starts empty", () => {
  const store = freshStore();
  assert.deepEqual(store.getSyncState(PL), { lastCheckedAt: null, lastError: null, count: null, availability: null, firstSyncAt: null });
  store.updateSyncState(PL, { lastCheckedAt: T0, count: 889, firstSyncAt: T0 });
  store.updateSyncState(PL, { lastError: "HTTP Error 429" });
  assert.deepEqual(store.getSyncState(PL), { lastCheckedAt: T0, lastError: "HTTP Error 429", count: 889, availability: null, firstSyncAt: T0 });
  store.deleteSyncState(PL);
  assert.equal(store.getSyncState(PL).count, null);
});
