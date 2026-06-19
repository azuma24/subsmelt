import test from "node:test";
import assert from "node:assert/strict";
import { buildFolderTree } from "./folderTree.js";
import type { ScannedFile } from "../../types.js";

// Minimal fixture factory — only the fields buildFolderTree touches.
function file(videoPath: string, videoName: string, videoMtime: number | null = null): ScannedFile {
  return { videoPath, videoName, videoMtime, subtitles: [] };
}

// ── name sort ────────────────────────────────────────────────────────────────

test("name asc: files within a folder are ordered A→Z by videoName", () => {
  const files = [
    file("/media/charlie.mp4", "charlie.mp4", 3),
    file("/media/alpha.mp4",   "alpha.mp4",   1),
    file("/media/bravo.mp4",   "bravo.mp4",   2),
  ];
  const tree = buildFolderTree(files, "name", "asc");
  assert.deepEqual(
    tree.files.map((f) => f.videoName),
    ["alpha.mp4", "bravo.mp4", "charlie.mp4"],
  );
});

test("name desc: files within a folder are ordered Z→A by videoName", () => {
  const files = [
    file("/media/alpha.mp4",   "alpha.mp4",   1),
    file("/media/bravo.mp4",   "bravo.mp4",   2),
    file("/media/charlie.mp4", "charlie.mp4", 3),
  ];
  const tree = buildFolderTree(files, "name", "desc");
  assert.deepEqual(
    tree.files.map((f) => f.videoName),
    ["charlie.mp4", "bravo.mp4", "alpha.mp4"],
  );
});

// ── date sort ─────────────────────────────────────────────────────────────────

test("date asc: files sorted oldest-first by videoMtime", () => {
  const files = [
    file("/media/c.mp4", "c.mp4", 300),
    file("/media/a.mp4", "a.mp4", 100),
    file("/media/b.mp4", "b.mp4", 200),
  ];
  const tree = buildFolderTree(files, "date", "asc");
  assert.deepEqual(
    tree.files.map((f) => f.videoMtime),
    [100, 200, 300],
  );
});

test("date desc: files sorted newest-first by videoMtime", () => {
  const files = [
    file("/media/a.mp4", "a.mp4", 100),
    file("/media/b.mp4", "b.mp4", 200),
    file("/media/c.mp4", "c.mp4", 300),
  ];
  const tree = buildFolderTree(files, "date", "desc");
  assert.deepEqual(
    tree.files.map((f) => f.videoMtime),
    [300, 200, 100],
  );
});

// ── null mtime always sorts last ──────────────────────────────────────────────

test("date asc: null videoMtime entries sort after all dated entries", () => {
  const files = [
    file("/media/null1.mp4", "null1.mp4", null),
    file("/media/early.mp4", "early.mp4", 50),
    file("/media/null2.mp4", "null2.mp4", null),
    file("/media/late.mp4",  "late.mp4",  500),
  ];
  const tree = buildFolderTree(files, "date", "asc");
  const names = tree.files.map((f) => f.videoName);
  // Dated entries come first (in ascending order), then the two nulls at the end.
  assert.equal(names[0], "early.mp4");
  assert.equal(names[1], "late.mp4");
  assert.ok(names[2] !== null && names[2].startsWith("null"));
  assert.ok(names[3] !== null && names[3].startsWith("null"));
});

test("date desc: null videoMtime entries sort after all dated entries even when direction is desc", () => {
  const files = [
    file("/media/null1.mp4", "null1.mp4", null),
    file("/media/early.mp4", "early.mp4", 50),
    file("/media/null2.mp4", "null2.mp4", null),
    file("/media/late.mp4",  "late.mp4",  500),
  ];
  const tree = buildFolderTree(files, "date", "desc");
  const names = tree.files.map((f) => f.videoName);
  // Dated entries come first (in descending order), then the two nulls.
  assert.equal(names[0], "late.mp4");
  assert.equal(names[1], "early.mp4");
  assert.ok(names[2] !== null && names[2].startsWith("null"));
  assert.ok(names[3] !== null && names[3].startsWith("null"));
});

test("date asc: all-null mtime list is stable (no crash)", () => {
  const files = [
    file("/media/x.mp4", "x.mp4", null),
    file("/media/y.mp4", "y.mp4", null),
  ];
  const tree = buildFolderTree(files, "date", "asc");
  assert.equal(tree.files.length, 2);
});

// ── folder ordering ───────────────────────────────────────────────────────────

test("name asc: top-level subfolders are ordered A→Z by folder name", () => {
  const files = [
    file("/media/zebra/z.mp4",  "z.mp4",  1),
    file("/media/alpha/a.mp4",  "a.mp4",  2),
    file("/media/mango/m.mp4",  "m.mp4",  3),
  ];
  const tree = buildFolderTree(files, "name", "asc");
  assert.deepEqual(
    tree.children.map((c) => c.name),
    ["alpha", "mango", "zebra"],
  );
});

test("name desc: top-level subfolders are ordered Z→A when direction is desc", () => {
  const files = [
    file("/media/alpha/a.mp4",  "a.mp4",  1),
    file("/media/mango/m.mp4",  "m.mp4",  2),
    file("/media/zebra/z.mp4",  "z.mp4",  3),
  ];
  const tree = buildFolderTree(files, "name", "desc");
  assert.deepEqual(
    tree.children.map((c) => c.name),
    ["zebra", "mango", "alpha"],
  );
});

test("date asc: folder sort direction still flips subfolder order (by name) when sortBy=date", () => {
  const files = [
    file("/media/zebra/z.mp4",  "z.mp4",  100),
    file("/media/alpha/a.mp4",  "a.mp4",  200),
  ];
  const ascTree  = buildFolderTree(files, "date", "asc");
  const descTree = buildFolderTree(files, "date", "desc");
  assert.deepEqual(ascTree.children.map((c) => c.name),  ["alpha", "zebra"]);
  assert.deepEqual(descTree.children.map((c) => c.name), ["zebra", "alpha"]);
});

// ── allPaths aggregation ──────────────────────────────────────────────────────

test("allPaths on root contains every videoPath regardless of depth", () => {
  const files = [
    file("/media/root.mp4",          "root.mp4",          1),
    file("/media/sub/child.mp4",     "child.mp4",         2),
    file("/media/sub/deep/leaf.mp4", "leaf.mp4",          3),
  ];
  const tree = buildFolderTree(files, "name", "asc");
  const expected = new Set([
    "/media/root.mp4",
    "/media/sub/child.mp4",
    "/media/sub/deep/leaf.mp4",
  ]);
  assert.equal(tree.allPaths.length, 3);
  for (const p of tree.allPaths) assert.ok(expected.has(p), `unexpected path: ${p}`);
});

test("allPaths on a subfolder node contains only its own descendant paths", () => {
  const files = [
    file("/media/a/file1.mp4", "file1.mp4", 1),
    file("/media/a/file2.mp4", "file2.mp4", 2),
    file("/media/b/other.mp4", "other.mp4", 3),
  ];
  const tree = buildFolderTree(files, "name", "asc");
  const nodeA = tree.children.find((c) => c.name === "a");
  assert.ok(nodeA, "folder 'a' should exist");
  assert.equal(nodeA.allPaths.length, 2);
  assert.ok(nodeA.allPaths.includes("/media/a/file1.mp4"));
  assert.ok(nodeA.allPaths.includes("/media/a/file2.mp4"));
  assert.ok(!nodeA.allPaths.includes("/media/b/other.mp4"));
});

test("allPaths with nested subfolders aggregates all descendant paths recursively", () => {
  const files = [
    file("/media/show/s01/ep01.mp4", "ep01.mp4", 1),
    file("/media/show/s01/ep02.mp4", "ep02.mp4", 2),
    file("/media/show/s02/ep01.mp4", "ep01.mp4", 3),
  ];
  const tree = buildFolderTree(files, "name", "asc");
  const showNode = tree.children.find((c) => c.name === "show");
  assert.ok(showNode, "folder 'show' should exist");
  assert.equal(showNode.allPaths.length, 3);
});
