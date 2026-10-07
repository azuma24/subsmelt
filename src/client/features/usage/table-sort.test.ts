import test from "node:test";
import assert from "node:assert/strict";
import { nextSort, sortRows } from "./table-sort";

const rows = [
  { name: "b.srt", cost: 0.5 },
  { name: "c.srt", cost: null },
  { name: "a.srt", cost: 2 },
  { name: "d.srt", cost: 0.1 },
];
const names = (list: typeof rows) => list.map((r) => r.name);

test("numbers sort both ways with unpriced rows last each time", () => {
  assert.deepEqual(names(sortRows(rows, (r) => r.cost, "asc")), ["d.srt", "b.srt", "a.srt", "c.srt"]);
  assert.deepEqual(names(sortRows(rows, (r) => r.cost, "desc")), ["a.srt", "b.srt", "d.srt", "c.srt"]);
});

test("strings sort both ways and the input is left as it was", () => {
  assert.deepEqual(names(sortRows(rows, (r) => r.name, "asc")), ["a.srt", "b.srt", "c.srt", "d.srt"]);
  assert.deepEqual(names(sortRows(rows, (r) => r.name, "desc")), ["d.srt", "c.srt", "b.srt", "a.srt"]);
  assert.deepEqual(names(rows), ["b.srt", "c.srt", "a.srt", "d.srt"]);
});

test("the active column flips and a new column starts at its own direction", () => {
  assert.deepEqual(nextSort({ key: "calls", dir: "desc" }, "calls", "desc"), { key: "calls", dir: "asc" });
  assert.deepEqual(nextSort({ key: "calls", dir: "asc" }, "calls", "desc"), { key: "calls", dir: "desc" });
  assert.deepEqual(nextSort({ key: "calls", dir: "asc" }, "file", "asc"), { key: "file", dir: "asc" });
});
