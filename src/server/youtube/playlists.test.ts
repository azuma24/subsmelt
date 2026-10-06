import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// playlists.ts reaches config.ts, which reads CONFIG_DIR at import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-playlists-"));
process.env.CONFIG_DIR = path.join(root, "config");
process.env.DATA_DIR = path.join(root, "data");
const { defaultPlaylistFields, folderFromTitle, parsePlaylistFields, parseStoredPlaylists, readPlaylists, removePlaylist, savePlaylist } =
  await import("./playlists.js");

const TODAY = "2026-09-30";
const PL = "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8";

test("parsePlaylistFields fills defaults and accepts a full video profile", () => {
  const parsed = parsePlaylistFields(
    { media: { type: "video", maxHeight: 720, codec: "h264", container: "mp4" }, backfill: { kind: "posted_since", date: "2026-08-01" }, mode: "manual", subtitleTaskIds: [2, 1, 2] },
    defaultPlaylistFields("AI"),
    TODAY,
  );
  assert.deepEqual(parsed, {
    ok: true,
    value: {
      folder: "AI",
      enabled: true,
      mode: "manual",
      backfill: { kind: "posted_since", date: "2026-08-01" },
      media: { type: "video", maxHeight: 720, codec: "h264", container: "mp4" },
      captions: "prefer_youtube",
      subtitleTaskIds: [2, 1],
      checkEveryMinutes: 60,
      include: { shorts: false, live: false },
    },
  });
});

test("parsePlaylistFields rejects impossible combinations and unsafe input", () => {
  const base = defaultPlaylistFields("AI");
  const error = (body: unknown) => {
    const result = parsePlaylistFields(body, base, TODAY);
    return result.ok ? null : result.error;
  };
  assert.equal(error({ media: { type: "audio", format: "mp3" } }), "media.format must be m4a or opus");
  assert.equal(error({ media: { type: "video", maxHeight: 720, codec: "h264", container: "avi" } }), "media.container must be mp4 or mkv");
  assert.equal(error({ backfill: { kind: "posted_since", date: "2026-10-01" } }), "backfill.date must be a YYYY-MM-DD date no later than today");
  assert.equal(error({ backfill: { kind: "posted_since", date: "2026-02-30" } }), "backfill.date must be a YYYY-MM-DD date no later than today");
  assert.equal(error({ folder: "../etc" }), "folder must be a relative folder name");
  assert.equal(error({ checkEveryMinutes: 5 }), "checkEveryMinutes must be a whole number from 15 to 10080");
  assert.equal(error([]), "Request body must be a JSON object");
});

test("folderFromTitle strips path and Windows-reserved characters", () => {
  assert.equal(folderFromTitle("AI: agents / tools?", PL), "AI agents tools");
  assert.equal(folderFromTitle("..", PL), PL);
});

test("parseStoredPlaylists drops entries that no longer validate", () => {
  const stored = JSON.stringify([
    { id: PL, title: "AI", folder: "AI", media: { type: "audio", format: "opus" } },
    { id: "bad id", title: "x" },
    { id: "PLbroken000", media: { type: "audio", format: "flac" } },
  ]);
  assert.deepEqual(parseStoredPlaylists(stored).map((p) => [p.id, p.title, p.media]), [[PL, "AI", { type: "audio", format: "opus" }]]);
  assert.deepEqual(parseStoredPlaylists("not json"), []);
});

test("savePlaylist replaces by id and removePlaylist reports whether it removed", () => {
  const playlist = { id: PL, title: "AI", ...defaultPlaylistFields("AI") };
  savePlaylist(playlist);
  savePlaylist({ ...playlist, title: "AI renamed" });
  assert.deepEqual(readPlaylists().map((p) => p.title), ["AI renamed"]);
  assert.equal(removePlaylist(PL), true);
  assert.equal(removePlaylist(PL), false);
  assert.deepEqual(readPlaylists(), []);
});

test("a channel's Shorts and live choice must be two true or false values", () => {
  const base = defaultPlaylistFields("Linus Tech Tips");
  assert.deepEqual(base.include, { shorts: false, live: false });
  const parsed = parsePlaylistFields({ include: { shorts: true, live: false } }, base, "2026-10-01");
  assert.deepEqual(parsed.ok && parsed.value.include, { shorts: true, live: false });
  assert.equal(parsePlaylistFields({ include: { shorts: "yes" } }, base, "2026-10-01").ok, false);
});
