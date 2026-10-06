import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSubtitleFile } from "./translator/cue-edits.js";
import { writeFileAtomic } from "./youtube/note-export.js";

// The container runs as root. Files it wrote came out 644 and folders 755,
// read-only to someone editing them from another computer over a share.
const mode = (p: string) => fs.statSync(p).mode & 0o777;

function mediaRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-share-"));
  fs.chmodSync(root, 0o755);
  return root;
}

test("a written subtitle and the folders created for it are writable by everyone", () => {
  const root = mediaRoot();
  const subtitle = path.join(root, "Channel", "Video", "video.zh-TW.srt");
  writeSubtitleFile(subtitle, "1\n00:00:01,000 --> 00:00:02,000\n你好\n");

  assert.equal(mode(subtitle), 0o666);
  assert.equal(mode(path.join(root, "Channel")), 0o777);
  assert.equal(mode(path.join(root, "Channel", "Video")), 0o777);
  // Folders the server did not create keep their owner's permissions.
  assert.equal(mode(root), 0o755);
});

test("an exported note is writable by everyone", () => {
  const root = mediaRoot();
  const note = path.join(root, "note.md");
  writeFileAtomic(note, "# Talk\n");

  assert.equal(mode(note), 0o666);
});
