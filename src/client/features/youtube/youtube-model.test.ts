import test from "node:test";
import assert from "node:assert/strict";
import type { TFunction } from "i18next";
import type { YoutubePreviewEntry, YoutubeVideo } from "../../types";
import { countByFilter, filterVideos, pickableVideos, statusCounts, videoActionLabelKey, videoActions, videoPipeline, videoStatusDescriptor } from "./video-status";
import { estimateSelection, formatGigabytes, includedEntries, postedPerMonth } from "./estimate";
import { followKind, followUrl } from "./format";

const t = ((key: string) => `t:${key}`) as unknown as TFunction;

function video(video_id: string, status: YoutubeVideo["status"], title: string, channel: string | null = null): YoutubeVideo {
  return {
    video_id, playlist_id: "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8", title, channel, duration_s: 148, published_at: "2026-09-30",
    added_at: null, status, skip_kind: null, reason: null, attempts: 0, retry_after: null, media_path: null, user_queued_at: null,
    position: 1, removed_at: null, subtitles: null, transcript_source: null, content_kind: null,
  };
}

const VIDEOS = [
  video("uXspbC2srEQ", "queued", "Introducing dots", "OpenAI"),
  video("BHPDsGVciDk", "downloading", "Best AI Release of 2026", "The PrimeTime"),
  video("RXGzy0H0GS0", "skipped", "2026亞運", "ELTA Sports"),
  video("LKsEieYbUz4", "unavailable", ""),
  video("HiT2MyR-ZYk", "done", "Paperclip - Managing Teams of AI Agents", "Full Stack"),
];

test("filterVideos leaves skipped and unavailable out of All, filters by tab, and searches title and channel", () => {
  // All goes group by group: in progress, then waiting, then done.
  assert.deepEqual(filterVideos(VIDEOS, "all", "").map((v) => v.video_id), ["BHPDsGVciDk", "uXspbC2srEQ", "HiT2MyR-ZYk"]);
  assert.deepEqual(filterVideos(VIDEOS, "off", "").map((v) => v.video_id), ["RXGzy0H0GS0", "LKsEieYbUz4"]);
  assert.deepEqual(filterVideos(VIDEOS, "bad", ""), []);
  assert.deepEqual(filterVideos(VIDEOS, "all", "primetime").map((v) => v.video_id), ["BHPDsGVciDk"]);
  assert.deepEqual(filterVideos(VIDEOS, "wait", "primetime"), []);
});

test("countByFilter keeps skipped and unavailable out of Kept and out of Needs attention", () => {
  assert.deepEqual(countByFilter({ queued: 61, new: 3, downloading: 4, done: 38, failed: 1, unavailable: 7, skipped: 784 }), {
    all: 107, run: 4, wait: 64, done: 38, bad: 1, off: 791,
  });
});

test("All's first page starts with what is moving, and group headers count every matching row", () => {
  const rows = [...Array.from({ length: 2000 }, (_, i) => video(`d${String(i).padStart(10, "0")}`, "done", `Done ${i}`)), video("q0000000000", "queued", "Next")];
  const visible = filterVideos(rows, "all", "");
  const counts = countByFilter(statusCounts(visible));
  assert.deepEqual([counts.done, counts.wait, visible[0].video_id, visible.slice(0, 200).length], [2000, 1, "q0000000000", 200]);
});

test("videoStatusDescriptor pairs every status with a glyph and a translated label", () => {
  assert.deepEqual(videoStatusDescriptor({ status: "unavailable" }, t), { glyph: "∅", tone: "neutral", label: "t:youtube.status.unavailable" });
  assert.deepEqual(videoStatusDescriptor({ status: "queued" }, t), { glyph: "··", tone: "neutral", label: "t:youtube.status.queued" });
  assert.deepEqual(videoStatusDescriptor({ status: "transcribing" }, t), { glyph: "··", tone: "warn", label: "t:youtube.status.subtitlesNext" });
  assert.deepEqual(videoStatusDescriptor({ status: "transcribing", pct: 40 }, t), { glyph: "≋", tone: "run", label: "t:youtube.status.transcribing" });
});

test("row actions per status mirror the server's action table", () => {
  const offered = (["new", "queued", "waiting", "downloading", "transcribing", "translating", "done", "failed", "unavailable", "skipped"] as const)
    .map((status) => [status, videoActions(status).map((action) => videoActionLabelKey(status, action))]);
  assert.deepEqual(offered, [
    ["new", ["youtube.actions.downloadNow", "youtube.actions.skip"]],
    ["queued", ["youtube.actions.downloadNow", "youtube.actions.skip"]],
    ["waiting", ["youtube.actions.downloadNow", "youtube.actions.skip"]],
    ["downloading", []],
    ["transcribing", []],
    ["translating", []],
    ["done", []],
    ["failed", ["youtube.actions.retry", "youtube.actions.skip"]],
    ["unavailable", ["youtube.actions.retry"]],
    ["skipped", ["youtube.actions.download"]],
  ]);
});

test("videoPipeline shows where a video is in download, subtitles, translate, note", () => {
  assert.deepEqual(videoPipeline({ status: "downloading", media_path: null }), ["now", "", "", ""]);
  assert.deepEqual(videoPipeline({ status: "transcribing", media_path: "YouTube/AI/x.m4a" }), ["done", "wait", "", ""]);
  assert.deepEqual(videoPipeline({ status: "failed", media_path: null }), ["fail", "", "", ""]);
  assert.deepEqual(videoPipeline({ status: "failed", media_path: "YouTube/AI/x.m4a" }), ["done", "fail", "", ""]);
  assert.deepEqual(videoPipeline({ status: "unavailable", media_path: null }), ["", "", "", ""]);
});

const ENTRIES: YoutubePreviewEntry[] = [
  { posted: "2026-09-30", added: "2026-09-30", durationS: 1800, kind: null },
  { posted: "2026-08-30", added: "2026-09-02", durationS: 3600, kind: null },
  { posted: "2026-07-30", added: null, durationS: 5400, kind: null },
  { posted: null, added: null, durationS: null, kind: null },
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

test("a shared GPU shows who waits: Whisper behind a translation batch, translation behind the transcriptions", async () => {
  const { gpuHold } = await import("./video-status");
  const pipeline = (shared: boolean, held: boolean, translationRunning: boolean) => ({ gpu: { shared, held, waitingFor: 2, translationRunning }, transcription: { ready: true, waiting: 0 } });
  assert.deepEqual(gpuHold(pipeline(false, true, true)), { whisper: false, translation: false });
  const hold = gpuHold(pipeline(true, true, false));
  assert.deepEqual(hold, { whisper: false, translation: true });
  assert.deepEqual(videoStatusDescriptor({ status: "translating" }, t, hold), { glyph: "··", tone: "warn", label: "t:youtube.status.translationHeld" });
  assert.deepEqual(videoPipeline({ status: "translating", media_path: "YouTube/AI/x.m4a" }, hold), ["done", "done", "wait", ""]);
  assert.deepEqual(videoStatusDescriptor({ status: "transcribing" }, t, gpuHold(pipeline(true, false, true))), { glyph: "··", tone: "warn", label: "t:youtube.status.gpuWait" });
});

test("subtitleSummary names the transcript's source and each language's route", async () => {
  const { subtitleSummary, NO_HOLD } = await import("./video-status");
  const tv = ((key: string, opts?: { lang?: string }) => `${key.replace("youtube.subs.", "")}(${opts?.lang ?? ""})`) as unknown as TFunction;
  const plan = { spoken: "zh-Hant", routes: [{ taskId: 1, kind: "same" as const }, { taskId: 2, kind: "captions" as const }, { taskId: 3, kind: "translate" as const }] };
  const translating = { subtitles: plan, transcript_source: "youtube_captions", status: "translating" as const };
  const codes = new Map([[1, "cht"], [2, "eng"]]);
  assert.equal(subtitleSummary(translating, codes, NO_HOLD, tv), "captions(ZH-Hant) · transcript(CHT) · creator(ENG) · translating(#3)");
  assert.equal(subtitleSummary(translating, codes, { whisper: false, translation: true }, tv), "captions(ZH-Hant) · transcript(CHT) · creator(ENG) · waiting(#3)");
  assert.equal(subtitleSummary({ subtitles: { spoken: "en", routes: [] }, transcript_source: "whisper:small", status: "done" }, codes, NO_HOLD, tv), "transcript(EN)");
  assert.equal(subtitleSummary({ subtitles: { spoken: null, routes: [{ taskId: 2, kind: "translate" }] }, transcript_source: null, status: "done" }, codes, NO_HOLD, tv), "transcriptOnly() · translated(ENG)");
});

test("a followed channel is told apart from a playlist by its uploads id", () => {
  assert.equal(followKind("UUXuqSBlHAE6Xw-yeJA0Tunw"), "channel");
  assert.equal(followKind("PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8"), "playlist");
  assert.equal(followUrl("UUXuqSBlHAE6Xw-yeJA0Tunw"), "https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw");
  assert.equal(followUrl("PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8"), "https://www.youtube.com/playlist?list=PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8");
});

test("only videos that can still be downloaded can be picked", () => {
  const rows = [video("a", "skipped", "A"), video("b", "unavailable", "B"), video("c", "done", "C"), video("d", "skipped", "D")];
  assert.deepEqual(pickableVideos(rows).map((v) => v.video_id), ["a", "d"]);
});

test("a channel's Shorts and live streams count only when they are included", () => {
  const entries: YoutubePreviewEntry[] = [
    { posted: "2026-09-30", added: null, durationS: 600, kind: "video" },
    { posted: "2026-09-29", added: null, durationS: 40, kind: "short" },
    { posted: "2026-09-28", added: null, durationS: 9000, kind: "live" },
    { posted: "2026-09-27", added: null, durationS: 600, kind: null },
  ];
  assert.equal(includedEntries(entries, { shorts: false, live: false }).length, 2);
  assert.equal(includedEntries(entries, { shorts: true, live: false }).length, 3);
  assert.equal(includedEntries(entries, { shorts: true, live: true }).length, 4);
});
