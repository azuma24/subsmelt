import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mediaRelativeDir,
  normalizeMediaSubfolder,
  resolveMediaSubfolder,
} from "./media-paths.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-media-"));
}

// ----- normalizeMediaSubfolder: user-supplied folder strings -----

test("normalize: accepts a plain relative folder", () => {
  assert.equal(normalizeMediaSubfolder("shows/Anime"), "shows/Anime");
  assert.equal(normalizeMediaSubfolder("  Movies  "), "Movies");
});

test("normalize: folds backslashes to forward slashes", () => {
  assert.equal(normalizeMediaSubfolder("shows\\Anime"), "shows/Anime");
});

test("normalize: rejects traversal (../) and absolute paths", () => {
  for (const bad of [
    "../etc",
    "../../etc/passwd",
    "a/../../b",
    "/etc",
    "//host",
  ]) {
    assert.equal(normalizeMediaSubfolder(bad), null, `should reject ${bad}`);
  }
});

test("normalize: rejects empty, NUL, and dot", () => {
  assert.equal(normalizeMediaSubfolder(""), null);
  assert.equal(normalizeMediaSubfolder("   "), null);
  assert.equal(normalizeMediaSubfolder("a\0b"), null);
  assert.equal(normalizeMediaSubfolder("."), null);
});

// ----- resolveMediaSubfolder: escaping the media root -----

test("resolve: maps a safe folder under the media root", () => {
  const root = tmpRoot();
  const resolved = resolveMediaSubfolder("shows/Anime", root)!;
  assert.ok(
    resolved.startsWith(root + path.sep),
    `${resolved} should be under ${root}`,
  );
  assert.equal(path.relative(root, resolved), path.join("shows", "Anime"));
});

test("resolve: returns null for traversal / absolute / root itself", () => {
  const root = tmpRoot();
  assert.equal(resolveMediaSubfolder("../etc", root), null);
  assert.equal(resolveMediaSubfolder("/etc/passwd", root), null);
  assert.equal(resolveMediaSubfolder(".", root), null);
});

test("resolve: a lexical escape that normalizes inside is confined", () => {
  const root = tmpRoot();
  // "a/../../b" normalizes to "../b" -> rejects; "a/../b" -> "b" -> allowed.
  assert.equal(resolveMediaSubfolder("a/../../b", root), null);
  const ok = resolveMediaSubfolder("a/../b", root)!;
  assert.equal(path.relative(root, ok), path.join("b"));
});

// ----- mediaRelativeDir: classifying job paths -----

test("relativeDir: classifies a file by folder", () => {
  const root = tmpRoot();
  const file = path.join(root, "shows", "Anime", "ep01.srt");
  assert.equal(mediaRelativeDir(file, root), "shows/Anime");
  assert.equal(mediaRelativeDir(path.join(root, "top.srt"), root), "");
});

test("relativeDir: returns null for a file outside the media root", () => {
  const root = tmpRoot();
  const outside = path.join(tmpRoot(), "secret.srt");
  assert.equal(mediaRelativeDir(outside, root), null);
});

test("relativeDir: a lexical .. escape is treated as outside", () => {
  const root = tmpRoot();
  assert.equal(
    mediaRelativeDir(path.join(root, "..", "etc", "passwd"), root),
    null,
  );
});
