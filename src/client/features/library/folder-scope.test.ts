import test from "node:test";
import assert from "node:assert/strict";
import { folderInScope, folderStats, folderTrail, statsFor } from "./folder-scope";

test("a folder includes its subfolders, but not folders that merely share a prefix", () => {
  assert.equal(folderInScope("UniFi", "UniFi"), true);
  assert.equal(folderInScope("UniFi/Tutorials", "UniFi"), true);
  assert.equal(folderInScope("UniFi Extras", "UniFi"), false);
  assert.equal(folderInScope("Movies", "UniFi"), false);
  assert.equal(folderInScope("anything", "all"), true);
});

test("the root and outside stand-in labels match only themselves", () => {
  assert.equal(folderInScope("(root)", "(root)", "(root)", "(outside)"), true);
  assert.equal(folderInScope("UniFi", "(root)", "(root)", "(outside)"), false);
});

test("a breadcrumb trail lists each ancestor", () => {
  assert.deepEqual(folderTrail("UniFi/Tutorials/2024"), ["UniFi", "UniFi/Tutorials", "UniFi/Tutorials/2024"]);
  assert.deepEqual(folderTrail(""), []);
});

test("folder stats count each Library file once, with every ancestor folder", () => {
  const stats = folderStats(
    [{ folder: "UniFi/Tutorials" }, { folder: "UniFi/Shorts" }, { folder: "" }],
    [
      { status: "done", folder: "UniFi/Tutorials" },
      { status: "error", folder: "UniFi/Shorts" },
      { status: "translating", folder: "UniFi/Shorts" },
      { status: "done", folder: null },
    ],
  );
  assert.deepEqual(statsFor(stats, ""), { files: 3, done: 1, waiting: 1, errors: 1 });
  assert.deepEqual(statsFor(stats, "UniFi"), { files: 2, done: 1, waiting: 1, errors: 1 });
  assert.deepEqual(statsFor(stats, "UniFi/Tutorials"), { files: 1, done: 1, waiting: 0, errors: 0 });
  assert.deepEqual(statsFor(stats, "Movies"), { files: 0, done: 0, waiting: 0, errors: 0 });
});
