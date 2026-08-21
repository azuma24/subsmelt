import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expansionStorageKey,
  loadExpanded,
  pruneExpanded,
  saveExpanded,
  type KeyValueStorage,
} from "./expansion-store";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
  };
}

test("expansionStorageKey namespaces per tree", () => {
  assert.equal(expansionStorageKey("whisper"), "fileTree.expanded.whisper");
});

test("loadExpanded returns empty set when nothing stored (default collapsed)", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadExpanded(storage, "whisper"), new Set());
});

test("loadExpanded restores stored paths", () => {
  const storage = memoryStorage({ "fileTree.expanded.whisper": JSON.stringify(["a", "a/b"]) });
  assert.deepEqual(loadExpanded(storage, "whisper"), new Set(["a", "a/b"]));
});

test("loadExpanded tolerates corrupt JSON and wrong shapes", () => {
  const storage = memoryStorage({ "fileTree.expanded.x": "{not json" });
  assert.deepEqual(loadExpanded(storage, "x"), new Set());
  const storage2 = memoryStorage({ "fileTree.expanded.x": JSON.stringify({ a: 1 }) });
  assert.deepEqual(loadExpanded(storage2, "x"), new Set());
  const storage3 = memoryStorage({ "fileTree.expanded.x": JSON.stringify(["ok", 42, null]) });
  assert.deepEqual(loadExpanded(storage3, "x"), new Set(["ok"]));
});

test("loadExpanded tolerates a throwing storage (private mode)", () => {
  const storage: KeyValueStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  assert.deepEqual(loadExpanded(storage, "x"), new Set());
  assert.doesNotThrow(() => saveExpanded(storage, "x", new Set(["a"])));
});

test("saveExpanded round-trips through loadExpanded", () => {
  const storage = memoryStorage();
  saveExpanded(storage, "scan", new Set(["movies", "movies/2024"]));
  assert.deepEqual(loadExpanded(storage, "scan"), new Set(["movies", "movies/2024"]));
});

test("pruneExpanded drops paths that no longer exist", () => {
  const pruned = pruneExpanded(new Set(["a", "a/b", "gone"]), new Set(["a", "a/b", "c"]));
  assert.deepEqual(pruned, new Set(["a", "a/b"]));
});

test("pruneExpanded returns the same set when nothing was pruned", () => {
  const expanded = new Set(["a"]);
  assert.equal(pruneExpanded(expanded, new Set(["a", "b"])), expanded);
});
