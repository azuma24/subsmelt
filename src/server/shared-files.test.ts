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

test("subtitle publication replaces entries without opening links at the old staging or output paths", (t) => {
  const root = mediaRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const subtitle = path.join(root, "video.srt");
  const original = path.join(root, "original.srt");
  fs.writeFileSync(original, "Original");
  fs.chmodSync(original, 0o600);
  fs.symlinkSync(original, subtitle);
  fs.symlinkSync(original, `${subtitle}.tmp`);

  writeSubtitleFile(subtitle, "Complete");
  assert.equal(fs.readFileSync(subtitle, "utf8"), "Complete");
  assert.equal(mode(subtitle), 0o666);
  assert.equal(fs.readFileSync(original, "utf8"), "Original");
  assert.equal(mode(original), 0o600);
  assert.equal(fs.lstatSync(`${subtitle}.tmp`).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(root).sort(), ["original.srt", "video.srt", "video.srt.tmp"]);
});

test("a failed subtitle rename leaves the existing output and removes private staging", (t) => {
  const root = mediaRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const subtitle = path.join(root, "video.srt");
  fs.writeFileSync(subtitle, "Previous version");
  t.mock.method(fs, "renameSync", () => {
    throw new Error("Rename failed");
  });

  assert.throws(() => writeSubtitleFile(subtitle, "Complete"), /Rename failed/);
  assert.equal(fs.readFileSync(subtitle, "utf8"), "Previous version");
  assert.deepEqual(fs.readdirSync(root), ["video.srt"]);
});

test("subtitle publication checks the destination directory when a media root is supplied", (t) => {
  const root = mediaRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = path.join(root, "media");
  const other = path.join(root, "other");
  fs.mkdirSync(media);
  fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(media, "alias"), "dir");

  assert.throws(() => writeSubtitleFile(path.join(media, "alias", "video.srt"), "Complete", media), /outside media/);
  assert.deepEqual(fs.readdirSync(other), []);
});

test("an exported note is writable by everyone", () => {
  const root = mediaRoot();
  const note = path.join(root, "note.md");
  writeFileAtomic(note, "# Talk\n");

  assert.equal(mode(note), 0o666);
});
