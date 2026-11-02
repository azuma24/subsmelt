import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// db.ts opens its database at import, so point DATA_DIR at a scratch folder first.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-log-retention-"));
const { default: db, getLogs, pruneLogs } = await import("./db.js");

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-06T12:00:00.000Z");
const insert = db.prepare("INSERT INTO logs (timestamp, level, category, message) VALUES (?, 'info', 'system', ?)");

test("logs older than the retention window go, newer ones stay", () => {
  db.prepare("DELETE FROM logs").run();
  insert.run(new Date(now - 45 * DAY).toISOString(), "six weeks old");
  insert.run(new Date(now - 31 * DAY).toISOString(), "just past a month");
  insert.run(new Date(now - 29 * DAY).toISOString(), "just inside a month");
  insert.run(new Date(now - 60_000).toISOString(), "a minute ago");

  assert.equal(pruneLogs({ now, maxAgeDays: 30, maxRows: 1000 }), 2);
  assert.deepEqual(
    getLogs().map((row) => row.message),
    ["a minute ago", "just inside a month"],
  );
});

test("past the row cap only the newest rows are kept", () => {
  db.prepare("DELETE FROM logs").run();
  for (let i = 1; i <= 10; i++) insert.run(new Date(now - (10 - i) * 1000).toISOString(), `entry ${i}`);

  assert.equal(pruneLogs({ now, maxAgeDays: 30, maxRows: 3 }), 7);
  assert.deepEqual(
    getLogs().map((row) => row.message),
    ["entry 10", "entry 9", "entry 8"],
  );
  assert.equal(pruneLogs({ now, maxAgeDays: 30, maxRows: 3 }), 0);
});
