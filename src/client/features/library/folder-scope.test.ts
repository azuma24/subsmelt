import test from "node:test";
import assert from "node:assert/strict";
import { folderInScope, folderStats, folderTrail, statsFor } from "./folder-scope";

test("a folder includes its subfolders, but not folders that merely share a prefix", () => {
  assert.equal(folderInScope("AnKor", "AnKor"), true);
  assert.equal(folderInScope("AnKor/Tutorials", "AnKor"), true);
  assert.equal(folderInScope("AnKor Extras", "AnKor"), false);
  assert.equal(folderInScope("Movies", "AnKor"), false);
  assert.equal(folderInScope("anything", ""), true);
});

test("a real folder named all only matches that subtree", () => {
  assert.equal(folderInScope("all", "all"), true);
  assert.equal(folderInScope("all/subfolder", "all"), true);
  assert.equal(folderInScope("all-other", "all"), false);
  assert.equal(folderInScope("sibling", "all"), false);
});

test("the root and outside stand-in labels match only themselves", () => {
  assert.equal(folderInScope("(root)", "(root)", "(root)", "(outside)"), true);
  assert.equal(folderInScope("AnKor", "(root)", "(root)", "(outside)"), false);
});

test("a breadcrumb trail lists each ancestor", () => {
  assert.deepEqual(folderTrail("AnKor/Tutorials/2024"), ["AnKor", "AnKor/Tutorials", "AnKor/Tutorials/2024"]);
  assert.deepEqual(folderTrail(""), []);
});

test("folder stats count each Library file once, with every ancestor folder", () => {
  const stats = folderStats(
    [{ folder: "AnKor/Tutorials" }, { folder: "AnKor/Shorts" }, { folder: "" }],
    [
      { status: "done", folder: "AnKor/Tutorials" },
      { status: "error", folder: "AnKor/Shorts" },
      { status: "translating", folder: "AnKor/Shorts" },
      { status: "done", folder: null },
    ],
  );
  assert.deepEqual(statsFor(stats, ""), { files: 3, done: 1, waiting: 1, errors: 1 });
  assert.deepEqual(statsFor(stats, "AnKor"), { files: 2, done: 1, waiting: 1, errors: 1 });
  assert.deepEqual(statsFor(stats, "AnKor/Tutorials"), { files: 1, done: 1, waiting: 0, errors: 0 });
  assert.deepEqual(statsFor(stats, "Movies"), { files: 0, done: 0, waiting: 0, errors: 0 });
});
