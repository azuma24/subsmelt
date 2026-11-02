import test from "node:test";
import assert from "node:assert/strict";
import { parseFolders, serializeFolders } from "./model.js";

test("folder lists round-trip as a JSON array so names may contain commas", () => {
  const folders = ["Movies, Classics", "Shows/Season 1", "Anime"];
  const raw = serializeFolders(folders);
  assert.equal(raw, '["Movies, Classics","Shows/Season 1","Anime"]');
  assert.deepEqual(parseFolders(raw), folders);
});

test("serializing drops duplicates and blanks", () => {
  assert.equal(serializeFolders(["a", "", "a", "b"]), '["a","b"]');
  assert.equal(serializeFolders([]), "[]");
});

test("the legacy comma list still parses", () => {
  assert.deepEqual(parseFolders("Movies, Shows ,,Anime"), ["Movies", "Shows", "Anime"]);
  assert.deepEqual(parseFolders(""), []);
});

test("a malformed JSON array falls back to the comma list", () => {
  assert.deepEqual(parseFolders('["Movies", "Shows'), ['["Movies"', '"Shows']);
});
