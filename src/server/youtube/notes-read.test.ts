import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-notes-read-"));
process.env.CONFIG_DIR = path.join(tmp, "config");
process.env.DATA_DIR = path.join(tmp, "data");
process.env.MEDIA_DIR = path.join(tmp, "media");
const root = path.join(tmp, "notes");
const other = path.join(tmp, "outside.md");
const PL = "PLnotesread0001";
const SECOND = "PLnotesread0002";
const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee", "ffffffffffF"];

const { setSetting } = await import("../config.js");
const { defaultPlaylistFields, savePlaylist, removePlaylist } = await import("./playlists.js");
const { YoutubeStore } = await import("./store.js");
const { YoutubeWorker } = await import("./worker.js");
const { registerYoutubeRoutes } = await import("../routes/youtube.js");
setSetting("youtube_notes_dir", root);
savePlaylist({ id: PL, title: "Talks", ...defaultPlaylistFields("Talks") });
savePlaylist({ id: SECOND, title: "Private", ...defaultPlaylistFields("Private") });
const store = new YoutubeStore(new Database(":memory:"));
const worker = new YoutubeWorker(store);
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
function seed(id: string, playlistId: string, status: "done" | "translating" = "done", reason?: string) {
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
        initial: { status, reason },
      },
    ],
    { complete: true, now: "2026-10-01T00:00:00.000Z" },
  );
}

test("missing mount is health, blocked export is listed, and detail is not readable", async () => {
  seed(ids[0], PL, "translating", `Notes folder ${root} is not mounted`);
  const result = await get("/api/youtube/notes");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.health, { path: root, exists: false, writable: false, blocked: true });
  assert.equal(result.body.total, 1);
  assert.equal(result.body.notes[0].status, "blocked");
  assert.equal(result.body.notes[0].reason, "Notes folder is not mounted");
  assert.deepEqual(result.body.countsByPlaylist[PL], { saved: 0, blocked: 1 });
  assert.equal(JSON.stringify(result.body.notes).includes(tmp), false);
  assert.equal((await get(`/api/youtube/notes/${ids[0]}`)).status, 404);
});

test("saved content search, state filter, deterministic pagination and followed ownership", async () => {
  fs.mkdirSync(path.join(root, "Talks"), { recursive: true });
  fs.writeFileSync(path.join(root, "Talks", "one.md"), "# First\nUnusual semantic needle");
  fs.writeFileSync(path.join(root, "Talks", "two.md"), "# Second\nDifferent material");
  seed(ids[1], PL);
  seed(ids[2], PL);
  seed(ids[3], SECOND);
  store.setNotePath(ids[1], path.join(root, "Talks", "one.md"), new Date().toISOString(), root);
  store.setNotePath(ids[2], path.join(root, "Talks", "two.md"), new Date().toISOString(), root);
  store.setNotePath(ids[3], path.join(root, "Talks", "one.md"), new Date().toISOString(), root);
  const search = await get("/api/youtube/notes?query=SEMANTIC&state=saved");
  assert.deepEqual(
    search.body.notes.map((n: { videoId: string }) => n.videoId),
    [ids[1], ids[3]],
  );
  assert.equal(search.body.notes[0].notePath, "Talks/one.md");
  assert.equal(search.body.notes[0].playlistTitle, "Talks");
  assert.ok(search.body.notes[0].exportedAt);
  const detail = await get(`/api/youtube/notes/${ids[1]}`);
  assert.equal(detail.body.content, "# First\nUnusual semantic needle");
  assert.deepEqual(detail.body.note, search.body.notes[0]);
  const all = await get("/api/youtube/notes?state=saved&limit=1&offset=1");
  assert.equal(all.body.total, 3);
  assert.deepEqual(all.body.countsByPlaylist[PL], { saved: 2, blocked: 1 });
  assert.equal(all.body.notes.length, 1);
  assert.equal(all.body.notes[0].videoId, ids[2]);
  assert.equal((await get(`/api/youtube/notes?playlistId=${PL}&state=saved`)).body.total, 2);
  assert.equal((await get("/api/youtube/notes?state=blocked")).body.total, 1);
  removePlaylist(SECOND);
  assert.equal((await get(`/api/youtube/notes/${ids[3]}`)).status, 404);
  assert.equal((await get("/api/youtube/notes?state=saved")).body.total, 2);
});

test("rejects malformed filters and unfollowed playlists", async () => {
  for (const query of [
    "limit=-1",
    "limit=101",
    "offset=999999999999999999",
    "state=other",
    "playlistId=not-followed",
    "query[]=bad",
    "limit=1.5",
  ]) {
    assert.equal((await get(`/api/youtube/notes?${query}`)).status, 400, query);
  }
  assert.equal((await get("/api/youtube/notes/not-a-video-id")).status, 404);
});

test("rejects paths outside root, symlink escapes, missing and oversized files", async () => {
  fs.writeFileSync(other, "secret outside");
  fs.symlinkSync(other, path.join(root, "Talks", "escape.md"));
  const unsafe = [
    other,
    path.join(root, "..", "outside.md"),
    path.join(root, "Talks", "escape.md"),
    path.join(root, "Talks", "missing.md"),
  ];
  seed(ids[4], PL);
  for (const file of unsafe) {
    store.setNotePath(ids[4], file, new Date().toISOString(), root);
    assert.equal((await get(`/api/youtube/notes/${ids[4]}`)).status, 404, file);
    assert.equal((await get("/api/youtube/notes?query=secret%20outside")).body.total, 0, file);
  }
  const huge = path.join(root, "Talks", "large.md");
  fs.writeFileSync(huge, Buffer.alloc(1024 * 1024 + 1));
  store.setNotePath(ids[4], huge, new Date().toISOString(), root);
  assert.equal((await get(`/api/youtube/notes/${ids[4]}`)).status, 404);
  assert.equal((await get("/api/youtube/notes?state=saved")).body.total, 2);
  const blocked = await get("/api/youtube/notes?state=blocked");
  assert.equal(blocked.body.countsByPlaylist[PL].blocked, 2);
  assert.equal(
    blocked.body.notes.find((note: { videoId: string }) => note.videoId === ids[4]).reason,
    "Saved note is missing or unreadable",
  );
});
