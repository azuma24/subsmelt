import test from "node:test";
import assert from "node:assert/strict";
import { folderInScope, folderTrail } from "./folder-scope";

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
