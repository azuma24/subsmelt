import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// note-reconcile.ts reaches note-export.ts, whose imports read CONFIG_DIR and MEDIA_DIR at load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-note-journal-"));
process.env.CONFIG_DIR = path.join(tmp, "config");
process.env.DATA_DIR = path.join(tmp, "data");
process.env.MEDIA_DIR = path.join(tmp, "media");
const root = path.join(tmp, "notes");
const PL = "PLjournal00001";
const OTHER = "PLjournal00002";
const T0 = "2026-10-20T10:00:00.000Z";
const T1 = "2026-10-20T11:00:00.000Z";
const DAY_LATER = "2026-10-21T11:00:01.000Z";

const { YoutubeStore } = await import("./store.js");
const { NoteCursorError } = await import("./note-journal.js");
const { reconcileSavedNotes } = await import("./note-reconcile.js");
type Store = InstanceType<typeof YoutubeStore>;

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function seed(store: Store, playlistId: string, videoId: string, status: "done" | "translating", reason?: string) {
  store.applyListing(
    playlistId,
    [
      {
        videoId,
        title: `Title ${videoId}`,
        channel: "Presenter",
        durationS: 42,
        publishedAt: "2026-10-01",
        position: 1,
        initial: { status, reason },
      },
    ],
    { complete: false, now: T0 },
  );
}

const events = (store: Store, after = 0) =>
  store.journal
    .page(after, 100)
    .changes.map((c) => [c.sequence, c.kind, c.videoId, c.playlistId, c.notePath, c.reason]);

const noteFile = (name: string) => path.join(root, "Talks", `${name}.md`);

function writeNote(name: string, body = `# ${name}`) {
  fs.mkdirSync(path.dirname(noteFile(name)), { recursive: true });
  fs.writeFileSync(noteFile(name), body);
}

test("the first start with a notes folder seeds saved notes and blocked exports once; a reopen keeps the journal", () => {
  const file = path.join(tmp, "seed.db");
  const db = new Database(file);
  const before = new YoutubeStore(db);
  seed(before, PL, "aaaaaaaaaaa", "done");
  seed(before, PL, "bbbbbbbbbbb", "done");
  seed(before, PL, "ccccccccccc", "translating", `Notes folder ${root} is not mounted`);
  seed(before, PL, "ddddddddddd", "done");
  seed(before, PL, "eeeeeeeeeee", "translating", "No subtitle found beside x.m4a");
  // Notes written before the journal existed: the row knows the path, the journal knows nothing.
  db.prepare("UPDATE youtube_videos SET note_path = ? WHERE video_id = ?").run(noteFile("a"), "aaaaaaaaaaa");
  db.prepare("UPDATE youtube_videos SET note_path = ? WHERE video_id = ?").run(path.join(tmp, "b.md"), "bbbbbbbbbbb");
  assert.equal(before.journal.head(), 0);
  db.close();

  const first = new YoutubeStore(new Database(file), { notesRoot: root });
  const generation = first.journal.generation();
  assert.match(generation, /^[0-9a-f]{16}$/);
  assert.deepEqual(events(first), [
    [1, "upsert", "aaaaaaaaaaa", PL, "Talks/a.md", null],
    [2, "unavailable", "bbbbbbbbbbb", PL, null, "note_unreadable"],
    [3, "unavailable", "ccccccccccc", PL, null, "notes_root_missing"],
  ]);
  assert.equal(first.journal.headCursor(), `${generation}.3`);

  const again = new YoutubeStore(new Database(file), { notesRoot: root });
  assert.equal(again.journal.generation(), generation);
  assert.equal(again.journal.head(), 3);
  assert.deepEqual(again.journal.page(0, 100), first.journal.page(0, 100));
});

test("setNotePath journals a write, a rename with the path it replaced, and a file outside the root as unavailable", () => {
  const store = new YoutubeStore(new Database(":memory:"));
  seed(store, PL, "aaaaaaaaaaa", "done");
  store.setNotePath("aaaaaaaaaaa", noteFile("one"), T0, root);
  store.setNotePath("aaaaaaaaaaa", noteFile("two"), T1, root);
  store.setNotePath("aaaaaaaaaaa", noteFile("two"), T1, root);
  store.setNotePath("aaaaaaaaaaa", path.join(tmp, "outside.md"), T1, root);
  const page = store.journal.page(0, 100);
  assert.deepEqual(
    page.changes.map((c) => [c.kind, c.notePath, c.previousNotePath, c.reason, c.at]),
    [
      ["upsert", "Talks/one.md", null, null, T0],
      ["upsert", "Talks/two.md", "Talks/one.md", null, T1],
      ["upsert", "Talks/two.md", null, null, T1],
      ["unavailable", null, null, "note_unreadable", T1],
    ],
  );
  assert.equal(page.changes[0].title, "Title aaaaaaaaaaa");
  assert.equal(store.getVideo("aaaaaaaaaaa")!.note_path, path.join(tmp, "outside.md"));
  assert.throws(() => store.setNotePath("zzzzzzzzzzz", noteFile("x"), T0, root), /Unknown video/);
});

test("a page is snapshotted at the head: events appended while paging are neither skipped nor claimed complete", () => {
  const store = new YoutubeStore(new Database(":memory:"));
  const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee", "fffffffffff", "ggggggggggg"];
  for (const id of ids) seed(store, PL, id, "done");
  for (const id of ids) store.setNotePath(id, noteFile(id), T0, root);
  const { journal } = store;
  const gen = journal.generation();

  const first = journal.page(0, 3);
  assert.deepEqual(
    first.changes.map((c) => c.sequence),
    [1, 2, 3],
  );
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, `${gen}.3`);
  assert.equal(first.head, `${gen}.7`);
  assert.equal(first.changes[2].cursor, `${gen}.3`);

  store.setNotePath(ids[0], noteFile("renamed"), T1, root);
  store.setNotePath(ids[1], noteFile("renamed2"), T1, root);
  const second = journal.page(journal.resolveCursor(first.nextCursor), 3);
  assert.deepEqual(
    second.changes.map((c) => c.sequence),
    [4, 5, 6],
  );
  assert.equal(second.hasMore, true);
  const third = journal.page(journal.resolveCursor(second.nextCursor), 3);
  assert.deepEqual(
    third.changes.map((c) => c.sequence),
    [7, 8, 9],
  );
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, third.head);
  const drained = journal.page(journal.resolveCursor(third.nextCursor), 3);
  assert.deepEqual(drained, { generation: gen, head: `${gen}.9`, changes: [], nextCursor: `${gen}.9`, hasMore: false });
  // Replaying a cursor returns the same page.
  assert.deepEqual(journal.page(0, 3).changes, first.changes);
});

test("malformed, foreign-generation and ahead-of-head cursors are refused by code", () => {
  const store = new YoutubeStore(new Database(":memory:"));
  seed(store, PL, "aaaaaaaaaaa", "done");
  store.setNotePath("aaaaaaaaaaa", noteFile("one"), T0, root);
  const { journal } = store;
  const gen = journal.generation();
  const foreign = gen === "0123456789abcdef" ? "fedcba9876543210" : "0123456789abcdef";
  const code = (cursor: string) => {
    try {
      journal.resolveCursor(cursor);
      return "accepted";
    } catch (error) {
      assert.ok(error instanceof NoteCursorError);
      return error.code;
    }
  };
  assert.equal(journal.resolveCursor(undefined), 0);
  assert.equal(journal.resolveCursor(""), 0);
  assert.equal(journal.resolveCursor(`${gen}.0`), 0);
  assert.equal(journal.resolveCursor(`${gen}.1`), 1);
  for (const bad of [
    "junk",
    "1",
    `${gen}`,
    `${gen}.`,
    `${gen}.01`,
    `${gen}.-1`,
    `${gen}.1.5`,
    `${gen.toUpperCase()}.1`,
  ])
    assert.equal(code(bad), "cursor_malformed", bad);
  assert.equal(code(`${foreign}.1`), "cursor_generation");
  assert.equal(code(`${gen}.2`), "cursor_ahead");
});

test("a notes-folder block is journaled once per reason; the export that follows is an upsert", () => {
  const store = new YoutubeStore(new Database(":memory:"));
  seed(store, PL, "aaaaaaaaaaa", "translating");
  store.noteExportFailed("aaaaaaaaaaa", `Notes folder ${root} is not mounted`, T0);
  store.noteExportFailed("aaaaaaaaaaa", `Notes folder ${root} is not mounted`, T1);
  store.noteExportFailed("aaaaaaaaaaa", `Notes folder ${root} is not writable`, T1);
  store.noteExportFailed("aaaaaaaaaaa", "No subtitle found beside x.m4a", T1);
  assert.equal(store.getVideo("aaaaaaaaaaa")!.reason, "No subtitle found beside x.m4a");
  store.setNotePath("aaaaaaaaaaa", noteFile("one"), T1, root);
  assert.deepEqual(events(store), [
    [1, "unavailable", "aaaaaaaaaaa", PL, null, "notes_root_missing"],
    [2, "unavailable", "aaaaaaaaaaa", PL, null, "notes_root_unwritable"],
    [3, "upsert", "aaaaaaaaaaa", PL, "Talks/one.md", null],
  ]);
  assert.equal(JSON.stringify(store.journal.page(0, 100)).includes(tmp), false);
});

test("a playlist taking over an orphaned video repeats the note's newest event under the new owner", () => {
  const store = new YoutubeStore(new Database(":memory:"));
  seed(store, PL, "aaaaaaaaaaa", "done");
  store.setNotePath("aaaaaaaaaaa", noteFile("one"), T0, root);
  const listing = (playlistId: string, ownerFollowed: boolean) =>
    store.applyListing(
      playlistId,
      [
        {
          videoId: "aaaaaaaaaaa",
          title: "Title aaaaaaaaaaa",
          channel: "Presenter",
          durationS: 42,
          publishedAt: "2026-10-01",
          position: 1,
          initial: { status: "queued" },
        },
      ],
      { complete: false, now: T1, isFollowed: () => ownerFollowed },
    );
  // The owner is still followed: a done video stays with it, and the journal says nothing.
  listing(OTHER, true);
  assert.equal(store.getVideo("aaaaaaaaaaa")!.playlist_id, PL);
  assert.equal(store.journal.head(), 1);
  // The owner was unfollowed: the other playlist takes the video, note included.
  listing(OTHER, false);
  assert.equal(store.getVideo("aaaaaaaaaaa")!.playlist_id, OTHER);
  assert.deepEqual(events(store, 1), [[2, "upsert", "aaaaaaaaaaa", OTHER, "Talks/one.md", null]]);
  // Listing it again under the same owner adds nothing.
  listing(OTHER, false);
  assert.equal(store.journal.head(), 2);
});

test("reconciliation checks nothing while the root is missing or empty, and never reads a note's body", () => {
  const store = new YoutubeStore(new Database(":memory:"));
  seed(store, PL, "aaaaaaaaaaa", "done");
  fs.rmSync(root, { recursive: true, force: true });
  store.setNotePath("aaaaaaaaaaa", noteFile("gone"), T0, root);
  const run = (now = T1) => reconcileSavedNotes(store, { root, now, after: null, limit: 50 });
  assert.deepEqual(run(), { skipped: "root_missing", checked: 0, events: 0, next: null });
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(run(), { skipped: "root_empty", checked: 0, events: 0, next: null });
  fs.mkdirSync(path.join(root, "Talks"));
  assert.deepEqual(run(), { skipped: null, checked: 1, events: 1, next: null });
  assert.deepEqual(events(store, 1), [[2, "unavailable", "aaaaaaaaaaa", PL, "Talks/gone.md", "note_missing"]]);
});

test("a note deleted by hand becomes unavailable, removed after a day, and an upsert once it is back", () => {
  const store = new YoutubeStore(new Database(":memory:"));
  seed(store, PL, "aaaaaaaaaaa", "done");
  writeNote("hand");
  store.setNotePath("aaaaaaaaaaa", noteFile("hand"), T0, root);
  const run = (now: string) => reconcileSavedNotes(store, { root, now, after: null, limit: 50 }).events;
  assert.equal(run(T1), 0);
  fs.rmSync(noteFile("hand"));
  assert.equal(run(T1), 1);
  assert.equal(run(T1), 0);
  assert.equal(run("2026-10-21T10:00:00.000Z"), 0);
  assert.equal(run(DAY_LATER), 1);
  assert.equal(run(DAY_LATER), 0);
  writeNote("hand", "# back");
  assert.equal(run(DAY_LATER), 1);
  fs.writeFileSync(noteFile("hand"), "# edited by hand");
  assert.equal(run(DAY_LATER), 0);
  assert.deepEqual(
    store.journal.page(0, 100).changes.map((c) => [c.kind, c.notePath, c.reason, c.at]),
    [
      ["upsert", "Talks/hand.md", null, T0],
      ["unavailable", "Talks/hand.md", "note_missing", T1],
      ["remove", "Talks/hand.md", null, DAY_LATER],
      ["upsert", "Talks/hand.md", null, DAY_LATER],
    ],
  );
});

test("reconciliation journals a note path the row changed without an event, and walks notes in batches", () => {
  const store = new YoutubeStore(new Database(":memory:"), { notesRoot: root });
  const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];
  for (const id of ids) {
    seed(store, PL, id, "done");
    writeNote(id);
    store.setNotePath(id, noteFile(id), T0, root);
  }
  writeNote("moved");
  // As a downgrade to 0.7.0 would leave it: the row moved on, the journal did not.
  (store as unknown as { db: Database.Database }).db
    .prepare("UPDATE youtube_videos SET note_path = ? WHERE video_id = ?")
    .run(noteFile("moved"), ids[1]);
  const batch = (after: string | null) => reconcileSavedNotes(store, { root, now: T1, after, limit: 1 });
  assert.deepEqual(batch(null), { skipped: null, checked: 1, events: 0, next: ids[0] });
  assert.deepEqual(batch(ids[0]), { skipped: null, checked: 1, events: 1, next: ids[1] });
  assert.deepEqual(batch(ids[1]), { skipped: null, checked: 1, events: 0, next: ids[2] });
  assert.deepEqual(batch(ids[2]), { skipped: null, checked: 0, events: 0, next: null });
  const latest = store.journal.latest(ids[1])!;
  assert.deepEqual(
    [latest.kind, latest.note_path, latest.previous_note_path],
    ["upsert", "Talks/moved.md", `Talks/${ids[1]}.md`],
  );
});
