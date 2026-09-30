import test from "node:test";
import assert from "node:assert/strict";
import type { TFunction } from "i18next";
import type { YoutubeVideo } from "../../types";
import { countByFilter, filterVideos, videoStatusDescriptor } from "./video-status";
import { estimateSelection, formatGigabytes, postedPerMonth } from "./estimate";

const t = ((key: string) => `t:${key}`) as unknown as TFunction;

function video(video_id: string, status: YoutubeVideo["status"], title: string, channel: string | null = null): YoutubeVideo {
  return {
    video_id, playlist_id: "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8", title, channel, duration_s: 148, published_at: "2026-09-30",
    added_at: null, status, skip_kind: null, reason: null, position: 1, removed_at: null,
  };
}

const VIDEOS = [
  video("uXspbC2srEQ", "queued", "Introducing dots", "OpenAI"),
  video("BHPDsGVciDk", "downloading", "Best AI Release of 2026", "The PrimeTime"),
  video("RXGzy0H0GS0", "skipped", "2026亞運", "ELTA Sports"),
  video("LKsEieYbUz4", "unavailable", ""),
  video("HiT2MyR-ZYk", "done", "Paperclip - Managing Teams of AI Agents", "Full Stack"),
];

test("filterVideos leaves skipped out of All, filters by tab, and searches title and channel", () => {
  assert.deepEqual(filterVideos(VIDEOS, "all", "").map((v) => v.video_id), ["uXspbC2srEQ", "BHPDsGVciDk", "LKsEieYbUz4", "HiT2MyR-ZYk"]);
  assert.deepEqual(filterVideos(VIDEOS, "off", "").map((v) => v.video_id), ["RXGzy0H0GS0"]);
  assert.deepEqual(filterVideos(VIDEOS, "bad", "").map((v) => v.video_id), ["LKsEieYbUz4"]);
  assert.deepEqual(filterVideos(VIDEOS, "all", "primetime").map((v) => v.video_id), ["BHPDsGVciDk"]);
  assert.deepEqual(filterVideos(VIDEOS, "wait", "primetime"), []);
});

test("countByFilter groups statuses into tabs and keeps skipped out of All", () => {
  assert.deepEqual(countByFilter({ queued: 61, new: 3, downloading: 4, done: 38, failed: 1, unavailable: 7, skipped: 784 }), {
    all: 114, run: 4, wait: 64, done: 38, bad: 8, off: 784,
  });
});

test("videoStatusDescriptor pairs every status with a glyph and a translated label", () => {
  assert.deepEqual(videoStatusDescriptor("unavailable", t), { glyph: "∅", tone: "bad", label: "t:youtube.status.unavailable" });
  assert.deepEqual(videoStatusDescriptor("queued", t), { glyph: "··", tone: "neutral", label: "t:youtube.status.queued" });
});

const ENTRIES = [
  { posted: "2026-09-30", added: "2026-09-30", durationS: 1800 },
  { posted: "2026-08-30", added: "2026-09-02", durationS: 3600 },
  { posted: "2026-07-30", added: null, durationS: 5400 },
  { posted: null, added: null, durationS: null },
];

test("estimateSelection counts videos, hours and disk for each backfill choice", () => {
  const audio = { type: "audio", format: "m4a" } as const;
  assert.deepEqual(estimateSelection(ENTRIES, { kind: "none" }, audio), { videos: 0, hours: 0, gigabytes: 0, approximate: false });
  const posted = estimateSelection(ENTRIES, { kind: "posted_since", date: "2026-08-01" }, audio);
  assert.deepEqual({ ...posted, gigabytes: Number(posted.gigabytes.toFixed(3)) }, { videos: 2, hours: 1.5, gigabytes: 0.087, approximate: true });
  const video720 = { type: "video", maxHeight: 720, codec: "h264", container: "mp4" } as const;
  assert.deepEqual(estimateSelection(ENTRIES, { kind: "all" }, video720), { videos: 4, hours: 3, gigabytes: 1.5, approximate: false });
  assert.deepEqual(estimateSelection(ENTRIES, { kind: "added_since", date: "2026-09-01" }, audio).videos, 2);
});

test("postedPerMonth counts posts per calendar month", () => {
  assert.deepEqual([...postedPerMonth(ENTRIES)], [["2026-09", 1], ["2026-08", 1], ["2026-07", 1]]);
});

test("formatGigabytes keeps one decimal under 10 GB", () => {
  assert.equal(formatGigabytes(2.345), "2.3 GB");
  assert.equal(formatGigabytes(21.7), "22 GB");
});

test("format helpers render durations, months and relative times", async () => {
  const { formatDuration, monthLabel, relativeFromNow, shortDate } = await import("./format");
  assert.equal(formatDuration(727), "12:07");
  assert.equal(formatDuration(6793), "1:53:13");
  assert.equal(formatDuration(null), "");
  assert.equal(monthLabel("2026-08-01", "en"), "August 2026");
  assert.equal(shortDate("2026-09-26", "en", new Date("2026-09-30T00:00:00Z")), "Sep 26");
  assert.equal(shortDate("2025-09-26", "en", new Date("2026-09-30T00:00:00Z")), "Sep 26, 2025");
  const now = Date.parse("2026-09-30T10:00:00Z");
  assert.equal(relativeFromNow("2026-09-30T09:54:00Z", "en", now), "6 min. ago");
  assert.equal(relativeFromNow("2026-09-30T10:54:00Z", "en", now), "in 54 min.");
});
