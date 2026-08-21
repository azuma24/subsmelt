import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRecentTargets, pushRecentTarget } from "./recent-targets";
import type { KeyValueStorage } from "../../components/file-tree/expansion-store";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
  };
}

test("empty storage yields empty list", () => {
  assert.deepEqual(loadRecentTargets(memoryStorage()), []);
});

test("push puts newest first, dedupes, caps at 5", () => {
  const storage = memoryStorage();
  for (const code of ["ja", "ko", "zh-TW", "ja", "fr", "de", "es"]) {
    pushRecentTarget(storage, code);
  }
  assert.deepEqual(loadRecentTargets(storage), ["es", "de", "fr", "ja", "zh-TW"]);
});

test("corrupt storage degrades to empty", () => {
  const storage = memoryStorage();
  storage.data.set("convert.recentTargets", "{nope");
  assert.deepEqual(loadRecentTargets(storage), []);
});
