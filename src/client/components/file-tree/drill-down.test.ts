import { test } from "node:test";
import assert from "node:assert/strict";
import { subtreeAt, deepestExistingPath } from "./drill-down";

interface N { path: string; children: N[] }
const node = (path: string, children: N[] = []): N => ({ path, children });

const roots = [
  node("a", [node("a/b", [node("a/b/c")])]),
  node("x"),
];

test("subtreeAt root path returns null (caller renders roots)", () => {
  assert.equal(subtreeAt(roots, ""), null);
});

test("subtreeAt finds a nested node by path", () => {
  assert.equal(subtreeAt(roots, "a/b")?.path, "a/b");
  assert.equal(subtreeAt(roots, "a/b/c")?.path, "a/b/c");
});

test("subtreeAt returns null for a missing path", () => {
  assert.equal(subtreeAt(roots, "a/zzz"), null);
});

test("deepestExistingPath keeps a valid path", () => {
  assert.equal(deepestExistingPath(roots, "a/b/c"), "a/b/c");
});

test("deepestExistingPath falls back to the deepest surviving ancestor", () => {
  assert.equal(deepestExistingPath(roots, "a/b/gone"), "a/b");
  assert.equal(deepestExistingPath(roots, "nope/deep"), "");
});
