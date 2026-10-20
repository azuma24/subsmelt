import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// playlists.ts reaches config.ts, which reads CONFIG_DIR at import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-second-brain-"));
process.env.CONFIG_DIR = path.join(root, "config");
process.env.DATA_DIR = path.join(root, "data");
const { defaultPlaylistFields } = await import("./playlists.js");
const { secondBrainFolders } = await import("./second-brain.js");

const playlist = (id: string, folder: string, secondBrainExport: boolean) => ({
  id,
  title: id,
  ...defaultPlaylistFields(folder),
  secondBrainExport,
});

test("only selected playlists' note folders are listed, relative and as notes name them", () => {
  assert.deepEqual(
    secondBrainFolders([
      playlist("PLnotes00001", "Talks/AI: agents", true),
      playlist("PLnotes00002", "Cooking", false),
      playlist("PLnotes00003", "Music", true),
    ]),
    { folders: ["Music", "Talks/AI agents"], withheld: [] },
  );
  assert.deepEqual(secondBrainFolders([playlist("PLnotes00002", "Cooking", false)]), { folders: [], withheld: [] });
});

test("a selected folder that would also carry an unselected playlist's notes is withheld", () => {
  const result = secondBrainFolders([
    playlist("PLshared0001", "AI", true),
    playlist("PLshared0002", "ai", false),
    playlist("PLparent0001", "Talks", true),
    playlist("PLparent0002", "Talks/Private", false),
    playlist("PLchild00001", "Docs/Public", true),
    playlist("PLchild00002", "Docs", false),
  ]);
  assert.deepEqual(result.folders, ["Docs/Public"]);
  assert.deepEqual(
    result.withheld.map((p) => p.id),
    ["PLshared0001", "PLparent0001"],
  );
});

test("folders never leave the notes folder and the notes folder itself is never listed", () => {
  const result = secondBrainFolders([
    playlist("PLdots000001", "...", true),
    playlist("PLdots000002", "../..x/./y", true),
    playlist("PLtwice00001", "Same", true),
    playlist("PLtwice00002", "same", true),
  ]);
  assert.deepEqual(result.folders, ["Same", "x/y"]);
  assert.deepEqual(
    result.withheld.map((p) => p.id),
    ["PLdots000001"],
  );
  for (const folder of result.folders) {
    assert.equal(path.isAbsolute(folder), false);
    assert.equal(folder.split("/").includes(".."), false);
  }
});
