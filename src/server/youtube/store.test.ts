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

test("nextQueued takes the user's picks first, then later finds newest check first, then playlist order", () => {
  const store = freshStore();
  store.applyListing(PL, [listed("aaaaaaaaaa1", 1), listed("aaaaaaaaaa2", 2), listed("aaaaaaaaaa3", 3)], { complete: true, now: T0 });
  store.applyListing(PL, [listed("bbbbbbbbbb1", 1), listed("aaaaaaaaaa1", 2), listed("aaaaaaaaaa2", 3), listed("aaaaaaaaaa3", 4)], { complete: true, now: T1 });
  const order = () => {
    const ids: string[] = [];
    for (let v = store.nextQueued([PL], T1); v; v = store.nextQueued([PL], T1)) {
      ids.push(v.video_id);
      store.setStatus(v.video_id, "downloading", { now: T1 });
    }
    return ids;
  };
  store.applyUserAction("aaaaaaaaaa3", "download", T1);
  assert.deepEqual(order(), ["aaaaaaaaaa3", "bbbbbbbbbb1", "aaaaaaaaaa1", "aaaaaaaaaa2"]);
});

test("nextQueued skips videos of other playlists, videos backing off, and removed videos nobody asked for", () => {
  const store = freshStore();
  store.applyListing(PL, [listed("aaaaaaaaaa1", 1), listed("aaaaaaaaaa2", 2), listed("aaaaaaaaaa3", 3)], { complete: true, now: T0 });
  store.applyListing("PLother00000", [listed("cccccccccc1", 1)], { complete: true, now: T0 });
  store.setStatus("aaaaaaaaaa1", "downloading", { now: T0 });
  store.setStatus("aaaaaaaaaa1", "queued", { retryAfter: T1, attempts: 1, now: T0 });
  store.applyListing(PL, [listed("aaaaaaaaaa1", 1), listed("aaaaaaaaaa3", 2)], { complete: true, now: T0 });

  assert.equal(store.nextQueued([PL], T0)?.video_id, "aaaaaaaaaa3");
  store.setStatus("aaaaaaaaaa3", "downloading", { now: T0 });
  assert.equal(store.nextQueued([PL], T0), undefined);
  assert.equal(store.nextQueued([PL], T1)?.video_id, "aaaaaaaaaa1");
  store.applyUserAction("aaaaaaaaaa2", "download", T0);
  assert.equal(store.nextQueued([PL], T0)?.video_id, "aaaaaaaaaa2");
});

test("applyUserAction moves by the action table and refuses the rest", () => {
  const store = freshStore();
  store.applyListing(PL, [listed("aaaaaaaaaa1", 1, { initial: { status: "new" } }), listed("aaaaaaaaaa2", 2)], { complete: true, now: T0 });

  const skipped = store.applyUserAction("aaaaaaaaaa1", "skip", T1);
  assert.deepEqual([skipped.status, skipped.skip_kind, skipped.user_queued_at], ["skipped", "user", null]);
  const queued = store.applyUserAction("aaaaaaaaaa1", "download", T1);
  assert.deepEqual([queued.status, queued.skip_kind, queued.user_queued_at], ["queued", null, T1]);

  store.setStatus("aaaaaaaaaa2", "downloading", { now: T0 });
  store.setStatus("aaaaaaaaaa2", "failed", { reason: "ERROR: boom", attempts: 4, now: T0 });
  const retried = store.applyUserAction("aaaaaaaaaa2", "retry", T1);
  assert.deepEqual([retried.status, retried.attempts, retried.reason], ["queued", 0, null]);
  assert.throws(() => store.applyUserAction("aaaaaaaaaa2", "retry", T1), IllegalTransitionError);
});

test("cooldown starts at an hour, doubles per strike, caps at a day, and clears", () => {
  const store = freshStore();
  const now = new Date(T0);
  assert.equal(store.activeCooldown(now), null);
  assert.deepEqual(store.startCooldown("rate_limited", now), { until: "2026-09-30T11:00:00.000Z", cause: "rate_limited", strikes: 1 });
  assert.deepEqual(store.startCooldown("bot_check", now), { until: "2026-09-30T12:00:00.000Z", cause: "bot_check", strikes: 2 });
  for (let i = 0; i < 4; i++) store.startCooldown("rate_limited", now);
  assert.deepEqual(store.startCooldown("rate_limited", now), { until: "2026-10-01T10:00:00.000Z", cause: "rate_limited", strikes: 7 });
  assert.equal(store.activeCooldown(new Date("2026-10-01T09:59:00.000Z"))?.strikes, 7);
  assert.equal(store.activeCooldown(new Date("2026-10-01T10:00:00.000Z")), null);
  store.clearCooldown();
  assert.equal(store.startCooldown("rate_limited", now).until, "2026-09-30T11:00:00.000Z");
});

test("a database from before user_queued_at gains the column", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE youtube_videos (video_id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, title TEXT NOT NULL, channel TEXT, duration_s INTEGER, published_at TEXT, added_at TEXT, status TEXT NOT NULL, skip_kind TEXT, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_after TEXT, media_path TEXT, subtitle_path TEXT, note_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const store = new YoutubeStore(db);
  store.applyListing(PL, [listed("aaaaaaaaaa1", 1, { initial: { status: "new" } })], { complete: true, now: T0 });
  assert.equal(store.applyUserAction("aaaaaaaaaa1", "download", T1).user_queued_at, T1);
});

const OTHER = "PLotherPlaylist01";
const owner = (store: YoutubeStore, id: string) => {
  const v = store.getVideo(id)!;
  return [v.playlist_id, v.status, v.skip_kind];
};

test("a video one playlist left out is taken over by a playlist that selects it", () => {
  const store = freshStore();
  store.applyListing(OTHER, [listed("aaaaaaaaaa1", 1, { initial: { status: "skipped", skipKind: "before_start" } }), listed("aaaaaaaaaa2", 2, { initial: { status: "new" } })], { complete: true, now: T0, resetUntouched: true });
  store.applyListing(PL, [listed("aaaaaaaaaa1", 1), listed("aaaaaaaaaa2", 2)], { complete: true, now: T1, resetUntouched: true });
  assert.deepEqual(owner(store, "aaaaaaaaaa1"), [PL, "queued", null]);
  assert.deepEqual(owner(store, "aaaaaaaaaa2"), [PL, "queued", null]);
});

test("another playlist never downgrades a video or overrides the user's skip or pick", () => {
  const store = freshStore();
  store.applyListing(OTHER, [
    listed("aaaaaaaaaa1", 1),
    listed("aaaaaaaaaa2", 2, { initial: { status: "new" } }),
    listed("aaaaaaaaaa3", 3, { initial: { status: "skipped", skipKind: "before_start" } }),
    listed("aaaaaaaaaa4", 4, { initial: { status: "new" } }),
  ], { complete: true, now: T0, resetUntouched: true });
  store.applyUserAction("aaaaaaaaaa2", "skip", T0);
  store.applyUserAction("aaaaaaaaaa4", "download", T0);
  store.applyListing(PL, [
    listed("aaaaaaaaaa1", 1, { initial: { status: "new" } }),
    listed("aaaaaaaaaa2", 2),
    listed("aaaaaaaaaa3", 3, { initial: { status: "skipped", skipKind: "before_start" } }),
    listed("aaaaaaaaaa4", 4, { initial: { status: "skipped", skipKind: "before_start" } }),
  ], { complete: true, now: T1, resetUntouched: true });
  assert.deepEqual(owner(store, "aaaaaaaaaa1"), [OTHER, "queued", null]);
  assert.deepEqual(owner(store, "aaaaaaaaaa2"), [OTHER, "skipped", "user"]);
  assert.deepEqual(owner(store, "aaaaaaaaaa3"), [OTHER, "skipped", "before_start"]);
  assert.deepEqual(owner(store, "aaaaaaaaaa4"), [OTHER, "queued", null]);
});
