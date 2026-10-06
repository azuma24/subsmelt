import test from "node:test";
import assert from "node:assert/strict";
import { needsExactDate, selectBackfill, type BackfillEntry } from "./backfill.js";

const TODAY = "2026-09-30";

// Rounded dates as a flat listing reports them, newest first.
const ENTRIES: BackfillEntry[] = [
  { videoId: "uXspbC2srEQ", publishedAt: "2026-09-30" },
  { videoId: "BHPDsGVciDk", publishedAt: "2026-09-26" },
  { videoId: "HiT2MyR-ZYk", publishedAt: "2026-08-30" },
  { videoId: "72Im-Mm5JKs", publishedAt: "2026-07-30" },
  { videoId: "qN6OM1IzjIE", publishedAt: "2025-09-30" },
];

const noLookups = async () => {
  throw new Error("no exact lookup expected");
};

test("All keeps every entry and None keeps nothing", async () => {
  const all = await selectBackfill({ kind: "all" }, ENTRIES, { exactUploadDate: noLookups, addedDates: null, today: TODAY });
  assert.deepEqual([...all.selected], ["uXspbC2srEQ", "BHPDsGVciDk", "HiT2MyR-ZYk", "72Im-Mm5JKs", "qN6OM1IzjIE"]);
  const none = await selectBackfill({ kind: "none" }, ENTRIES, { exactUploadDate: noLookups, addedDates: null, today: TODAY });
  assert.deepEqual([...none.selected], []);
});

test("Posted since looks up exact dates only for entries inside the rounding window", async () => {
  const looked: string[] = [];
  const exact: Record<string, string> = { "HiT2MyR-ZYk": "2026-08-12", "72Im-Mm5JKs": "2026-07-28" };
  const result = await selectBackfill({ kind: "posted_since", date: "2026-08-01" }, ENTRIES, {
    exactUploadDate: async (id) => {
      looked.push(id);
      return exact[id] ?? null;
    },
    addedDates: null,
    today: TODAY,
  });

  assert.deepEqual(looked, ["HiT2MyR-ZYk"]);
  assert.deepEqual([...result.selected], ["uXspbC2srEQ", "BHPDsGVciDk", "HiT2MyR-ZYk"]);
  assert.deepEqual([...result.exactDates], [["HiT2MyR-ZYk", "2026-08-12"]]);
});

test("Posted since keeps the rounded date when the exact lookup fails", async () => {
  const result = await selectBackfill({ kind: "posted_since", date: "2026-08-01" }, [{ videoId: "HiT2MyR-ZYk", publishedAt: "2026-08-30" }], {
    exactUploadDate: async () => null,
    addedDates: null,
    today: TODAY,
  });
  assert.deepEqual([...result.selected], ["HiT2MyR-ZYk"]);
});

test("Added since compares the playlist added dates and needs them", async () => {
  const addedDates = new Map([
    ["uXspbC2srEQ", "2026-09-30"],
    ["qN6OM1IzjIE", "2026-09-02"],
    ["HiT2MyR-ZYk", "2026-06-01"],
  ]);
  const result = await selectBackfill({ kind: "added_since", date: "2026-09-01" }, ENTRIES, { exactUploadDate: noLookups, addedDates, today: TODAY });
  assert.deepEqual([...result.selected], ["uXspbC2srEQ", "qN6OM1IzjIE"]);

  await assert.rejects(
    selectBackfill({ kind: "added_since", date: "2026-09-01" }, ENTRIES, { exactUploadDate: noLookups, addedDates: null, today: TODAY }),
    /Added since needs a working YouTube Data API key/,
  );
});

test("needsExactDate checks only rounded dates at or just past the cutoff", () => {
  assert.equal(needsExactDate("2026-08-30", "2026-08-01", TODAY), true);
  assert.equal(needsExactDate("2026-09-15", "2026-09-10", TODAY), true);
  assert.equal(needsExactDate("2026-09-26", "2026-09-25", TODAY), false);
  assert.equal(needsExactDate("2026-07-30", "2026-08-01", TODAY), false);
  assert.equal(needsExactDate("2025-09-30", "2025-01-01", TODAY), true);
  assert.equal(needsExactDate(null, "2026-01-01", TODAY), true);
});
