import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-notes-changes-"));
process.env.CONFIG_DIR = path.join(tmp, "config");
process.env.DATA_DIR = path.join(tmp, "data");
process.env.MEDIA_DIR = path.join(tmp, "media");
const root = path.join(tmp, "notes");
const PL = "PLchanges00001";
const SECOND = "PLchanges00002";
const T0 = "2026-10-20T10:00:00.000Z";

const { setSetting } = await import("../config.js");
const { defaultPlaylistFields, savePlaylist, removePlaylist, findPlaylist } = await import("./playlists.js");
const { YoutubeStore } = await import("./store.js");
const { YoutubeWorker } = await import("./worker.js");
const { registerYoutubeRoutes } = await import("../routes/youtube.js");
setSetting("youtube_notes_dir", root);
fs.mkdirSync(path.join(root, "Talks"), { recursive: true });
savePlaylist({ id: PL, title: "Talks", ...defaultPlaylistFields("Talks") });
const db = new Database(":memory:");
const store = new YoutubeStore(db, { notesRoot: root });
const worker = new YoutubeWorker(store, { now: () => new Date(T0) });
worker.stop();
const app = express();
registerYoutubeRoutes(app, store, worker);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function get(url: string) {
  const response = await fetch(`${base}${url}`);
  return { status: response.status, body: await response.json() };
}
const gen = store.journal.generation();

function seed(id: string, playlistId: string, status: "done" | "queued" = "done") {
  store.applyListing(
    playlistId,
    [
      {
        videoId: id,
        title: `Title ${id}`,
        channel: "Presenter",
        durationS: 42,
        publishedAt: "2026-10-01",
        position: 1,
        initial: { status },
      },
    ],
    { complete: false, now: T0 },
  );
}

function writeNote(name: string) {
  const file = path.join(root, "Talks", `${name}.md`);
  fs.writeFileSync(file, `# ${name}`);
  return file;
}

test("/notes/changes and /notes/sync-state answer before the detail route, and an empty journal bootstraps", async () => {
  const changes = await get("/api/youtube/notes/changes");
  assert.equal(changes.status, 200);
  assert.deepEqual(changes.body, {
    generation: gen,
    head: `${gen}.0`,
    changes: [],
    nextCursor: `${gen}.0`,
    hasMore: false,
  });
  const state = await get("/api/youtube/notes/sync-state");
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, {
    generation: gen,
    head: `${gen}.0`,
    selectionRevision: state.body.selectionRevision,
    selection: [],
    notesRoot: { exists: true, writable: true },
  });
  assert.match(state.body.selectionRevision, /^[0-9a-f]{16}$/);
  assert.equal((await get("/api/youtube/notes/changes/")).status, 200);
  assert.equal((await get("/api/youtube/notes/not-a-video-id")).status, 404);
});

test("a written note and a re-export under a new name reach the feed with relative paths only", async () => {
  seed("aaaaaaaaaaa", PL);
  store.setNotePath("aaaaaaaaaaa", writeNote("first"), T0, root);
  store.setNotePath("aaaaaaaaaaa", writeNote("second"), T0, root);
  const { status, body } = await get("/api/youtube/notes/changes");
  assert.equal(status, 200);
  assert.deepEqual(body.changes, [
    {
      sequence: 1,
      cursor: `${gen}.1`,
      kind: "upsert",
      videoId: "aaaaaaaaaaa",
      playlistId: PL,
      notePath: "Talks/first.md",
      previousNotePath: null,
      title: "Title aaaaaaaaaaa",
      reason: null,
      at: T0,
    },
    {
      sequence: 2,
      cursor: `${gen}.2`,
      kind: "upsert",
      videoId: "aaaaaaaaaaa",
      playlistId: PL,
      notePath: "Talks/second.md",
      previousNotePath: "Talks/first.md",
      title: "Title aaaaaaaaaaa",
      reason: null,
      at: T0,
    },
  ]);
  assert.deepEqual([body.head, body.nextCursor, body.hasMore], [`${gen}.2`, `${gen}.2`, false]);
  assert.equal(JSON.stringify(body).includes(tmp), false);
  // The detail route stays the only source of the body.
  const detail = await get("/api/youtube/notes/aaaaaaaaaaa");
  assert.equal(detail.body.content, "# second");
  assert.equal(detail.body.note.notePath, "Talks/second.md");
});

test("bad cursors and limits are refused with a code, and a gone cursor says where to start again", async () => {
  const foreign = gen === "0123456789abcdef" ? "fedcba9876543210" : "0123456789abcdef";
  const malformed = await get("/api/youtube/notes/changes?after=junk");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "cursor_malformed");
  const generation = await get(`/api/youtube/notes/changes?after=${foreign}.1`);
  assert.equal(generation.status, 410);
  assert.deepEqual(generation.body, {
    error: "Cursor belongs to another journal generation; start again",
    code: "cursor_generation",
    generation: gen,
    head: `${gen}.2`,
  });
  const ahead = await get(`/api/youtube/notes/changes?after=${gen}.99`);
  assert.equal(ahead.status, 410);
  assert.equal(ahead.body.code, "cursor_ahead");
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=-1",
    "limit=1.5",
    "limit=abc",
    "limit[]=1",
    "after[]=x",
    "page=1",
  ])
    assert.equal((await get(`/api/youtube/notes/changes?${query}`)).status, 400, query);
  assert.equal((await get(`/api/youtube/notes/changes?after=${gen}.2&limit=1`)).body.hasMore, false);
});

test("paging with a write in between neither skips nor repeats, and a cursor replays the same page", async () => {
  seed("bbbbbbbbbbb", PL);
  seed("ccccccccccc", PL);
  store.setNotePath("bbbbbbbbbbb", writeNote("b"), T0, root);
  store.setNotePath("ccccccccccc", writeNote("c"), T0, root);
  const first = await get(`/api/youtube/notes/changes?after=${gen}.1&limit=2`);
  assert.deepEqual(
    [first.body.changes.map((c: { sequence: number }) => c.sequence), first.body.hasMore, first.body.nextCursor],
    [[2, 3], true, `${gen}.3`],
  );
  store.setNotePath("bbbbbbbbbbb", writeNote("b2"), T0, root);
  const second = await get(`/api/youtube/notes/changes?after=${first.body.nextCursor}&limit=2`);
  assert.deepEqual(
    [second.body.changes.map((c: { sequence: number }) => c.sequence), second.body.hasMore, second.body.head],
    [[4, 5], false, `${gen}.5`],
  );
  const replay = await get(`/api/youtube/notes/changes?after=${gen}.1&limit=2`);
  assert.deepEqual([replay.body.changes, replay.body.nextCursor], [first.body.changes, first.body.nextCursor]);
  assert.equal(replay.body.head, second.body.head);
  assert.deepEqual((await get(`/api/youtube/notes/changes?after=${second.body.nextCursor}`)).body.changes, []);
});

test("selection changes move the revision and add no note event; an unfollow leaves the selection", async () => {
  const before = await get("/api/youtube/notes/sync-state");
  savePlaylist({ ...findPlaylist(PL)!, secondBrainExport: true });
  savePlaylist({
    id: SECOND,
    title: "Private",
    ...defaultPlaylistFields("Talks/Private: 2026"),
    secondBrainExport: true,
  });
  const selected = await get("/api/youtube/notes/sync-state");
  assert.deepEqual(selected.body.selection, [
    { playlistId: PL, title: "Talks", folder: "Talks" },
    { playlistId: SECOND, title: "Private", folder: "Talks/Private 2026" },
  ]);
  assert.notEqual(selected.body.selectionRevision, before.body.selectionRevision);
  assert.equal(selected.body.head, before.body.head);
  savePlaylist({ ...findPlaylist(PL)!, secondBrainExport: false });
  const unticked = await get("/api/youtube/notes/sync-state");
  assert.deepEqual(
    unticked.body.selection.map((s: { playlistId: string }) => s.playlistId),
    [SECOND],
  );
  assert.notEqual(unticked.body.selectionRevision, selected.body.selectionRevision);
  removePlaylist(SECOND);
  const unfollowed = await get("/api/youtube/notes/sync-state");
  assert.deepEqual(unfollowed.body.selection, []);
  assert.equal(unfollowed.body.selectionRevision, before.body.selectionRevision);
  assert.equal(unfollowed.body.head, before.body.head);
  assert.equal((await get("/api/youtube/notes/changes")).body.head, before.body.head);
});

test("the worker journals a blocked export once while the root is gone, and the note once it is back", async () => {
  const media = path.join(tmp, "media", "YouTube", "Talks");
  fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, "blocked.m4a"), "audio");
  fs.writeFileSync(path.join(media, "blocked.en.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHello.\n");
  seed("ddddddddddd", PL, "queued");
  store.setStatus("ddddddddddd", "downloading", { now: T0 });
  store.setStatus("ddddddddddd", "transcribing", { now: T0, mediaPath: "YouTube/Talks/blocked.m4a" });
  store.setStatus("ddddddddddd", "translating", { now: T0 });
  const head = store.journal.head();
  fs.renameSync(root, `${root}.away`);
  try {
    await worker.onSubtitlesComplete("ddddddddddd");
    await worker.onSubtitlesComplete("ddddddddddd");
    const state = await get("/api/youtube/notes/sync-state");
    assert.deepEqual(state.body.notesRoot, { exists: false, writable: false });
    assert.equal(JSON.stringify(state.body).includes(tmp), false);
    const blocked = await get(`/api/youtube/notes/changes?after=${gen}.${head}`);
    assert.deepEqual(
      blocked.body.changes.map((c: Record<string, unknown>) => [c.kind, c.videoId, c.notePath, c.reason]),
      [["unavailable", "ddddddddddd", null, "notes_root_missing"]],
    );
    assert.equal(store.getVideo("ddddddddddd")!.status, "translating");
    // The list reports every saved note as blocked while the root is away; the feed said nothing about them.
    const listed = (await get("/api/youtube/notes?state=blocked")).body.notes;
    assert.equal(
      listed.find((n: { videoId: string }) => n.videoId === "ddddddddddd").reason,
      "Notes folder is not mounted",
    );
  } finally {
    fs.renameSync(`${root}.away`, root);
  }
  await worker.onSubtitlesComplete("ddddddddddd");
  assert.equal(store.getVideo("ddddddddddd")!.status, "done");
  const written = await get(`/api/youtube/notes/changes?after=${gen}.${head + 1}`);
  assert.deepEqual(
    written.body.changes.map((c: Record<string, unknown>) => [c.kind, c.videoId, c.notePath, c.previousNotePath]),
    [["upsert", "ddddddddddd", "Talks/Title ddddddddddd (ddddddddddd).md", null]],
  );
  assert.equal((await get("/api/youtube/notes/ddddddddddd")).status, 200);
});

test("a feed page over thousands of notes reads nothing from the filesystem", async () => {
  const ids = Array.from({ length: 5000 }, (_, i) => `n${String(i).padStart(10, "0")}`);
  db.transaction(() => {
    for (const id of ids) {
      seed(id, PL);
      store.setNotePath(id, path.join(root, "Talks", `${id}.md`), T0, root);
    }
  })();
  const head = store.journal.head();
  const watched = [
    "statSync",
    "lstatSync",
    "existsSync",
    "readdirSync",
    "openSync",
    "realpathSync",
    "accessSync",
    "opendirSync",
    "readFileSync",
  ] as const;
  const calls: Record<string, number> = {};
  const originals = Object.fromEntries(watched.map((name) => [name, fs[name]])) as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const name of watched) {
    (fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return originals[name](...args);
    };
  }
  try {
    let cursor = `${gen}.${head - 5000}`;
    let pages = 0;
    let seen = 0;
    for (;;) {
      const { status, body } = await get(`/api/youtube/notes/changes?after=${cursor}&limit=100`);
      assert.equal(status, 200);
      pages += 1;
      seen += body.changes.length;
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    assert.deepEqual([pages, seen, cursor], [50, 5000, `${gen}.${head}`]);
    assert.deepEqual(calls, {});
    await get("/api/youtube/notes/sync-state");
    assert.ok(Object.values(calls).reduce((a, b) => a + b, 0) <= 2, JSON.stringify(calls));
  } finally {
    for (const name of watched) (fs as unknown as Record<string, unknown>)[name] = originals[name];
  }
});
