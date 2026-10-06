import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPathTree, relativeDisplayPath } from "./build";

interface Item { p: string; name: string }
const item = (p: string): Item => ({ p, name: p.split("/").pop() ?? p });

const byName = (a: Item, b: Item) => a.name.localeCompare(b.name);

test("buildPathTree nests folders from slash paths", () => {
  const root = buildPathTree(
    [item("/media/movies/2024/film.mkv"), item("/media/movies/short.mkv"), item("/media/top.mkv")],
    { pathOf: (f) => f.p, marker: "/media/", compareFiles: byName, compareFolders: (a, b) => a.localeCompare(b) },
  );
  assert.equal(root.files.length, 1);
  assert.equal(root.children.length, 1);
  const movies = root.children[0];
  assert.equal(movies.path, "movies");
  assert.equal(movies.files.length, 1);
  assert.equal(movies.children[0].path, "movies/2024");
});

test("buildPathTree honors a custom marker", () => {
  const root = buildPathTree([item("/mnt/library/show/ep1.mkv")], {
    pathOf: (f) => f.p,
    marker: "/mnt/library/",
    compareFiles: byName,
    compareFolders: (a, b) => a.localeCompare(b),
  });
  assert.equal(root.children[0].path, "show");
});

test("buildPathTree collects allFiles and allPaths recursively", () => {
  const root = buildPathTree(
    [item("/media/a/b/deep.mkv"), item("/media/a/mid.mkv")],
    { pathOf: (f) => f.p, marker: "/media/", compareFiles: byName, compareFolders: (a, b) => a.localeCompare(b) },
  );
  const a = root.children[0];
  assert.equal(a.allFiles.length, 2);
  assert.deepEqual(a.allPaths, ["/media/a/mid.mkv", "/media/a/b/deep.mkv"]);
});

test("relativeDisplayPath strips the marker prefix", () => {
  assert.equal(relativeDisplayPath("/media/developer/sub/file.mp4", "/media/"), "developer/sub/file.mp4");
  assert.equal(relativeDisplayPath("no-marker/file.mp4", "/media/"), "no-marker/file.mp4");
});
