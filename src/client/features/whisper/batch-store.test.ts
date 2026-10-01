import test from "node:test";
import assert from "node:assert/strict";
import { IDLE, applyProgressEvent, beginFile, cancelBatch, endBatch, fileFinished, getBatchState, hasLiveTranscriptions, runBatch, startBatch } from "./batch-store.js";
import type { TranscribeRequest, TranscribeResponse } from "../../types.js";

const request = (videoPath: string): TranscribeRequest => ({ videoPath, postAction: "transcribe_only" });
const response = { ok: true } as TranscribeResponse;

test("a batch starts with a fresh progress counter and no badges", () => {
  const dirty = { ...IDLE, fileProgress: { "/a.mkv": { done: true } } };
  assert.deepEqual(startBatch(dirty, 3), { running: true, progress: { done: 0, total: 3 }, activePath: null, fileProgress: {} });
});

test("a finished file records its outcome and advances the counter", () => {
  const running = beginFile(startBatch(IDLE, 2), "/a.mkv");
  assert.equal(running.activePath, "/a.mkv");
  const afterDone = fileFinished(running, "/a.mkv", "done", 1);
  assert.deepEqual(afterDone.fileProgress, { "/a.mkv": { pct: 100, done: true } });
  assert.deepEqual(afterDone.progress, { done: 1, total: 2 });
  const afterError = fileFinished(afterDone, "/b.mkv", "error", 2);
  assert.deepEqual(afterError.fileProgress["/b.mkv"], { error: true });
  assert.deepEqual(endBatch(afterError), { running: false, progress: null, activePath: null, fileProgress: afterError.fileProgress });
});

test("a phase-only progress event keeps the last percentage", () => {
  const withPct = applyProgressEvent(IDLE, { path: "/a.mkv", pct: 40 });
  const withPhase = applyProgressEvent(withPct, { path: "/a.mkv", phase: "diarizing" });
  assert.deepEqual(withPhase.fileProgress, { "/a.mkv": { pct: 40, phase: "diarizing" } });
  assert.equal(applyProgressEvent(IDLE, { pct: 5 }), IDLE);
});

test("runBatch runs the files in order, reports failures, and ends idle with badges", async () => {
  const sent: string[] = [];
  const errors: [string, string][] = [];
  let finished: [number, number] | null = null;
  await runBatch({
    paths: ["/a.mkv", "/b.mkv"],
    request,
    transcribe: async (req) => {
      sent.push(req.videoPath);
      if (req.videoPath === "/b.mkv") throw new Error("boom");
      return response;
    },
    onFileError: (path, message) => errors.push([path, message]),
    onFinished: (ok, total) => { finished = [ok, total]; },
  });
  assert.deepEqual(sent, ["/a.mkv", "/b.mkv"]);
  assert.deepEqual(errors, [["/b.mkv", "boom"]]);
  assert.deepEqual(finished, [1, 2]);
  assert.deepEqual(getBatchState(), {
    running: false,
    progress: null,
    activePath: null,
    fileProgress: { "/a.mkv": { pct: 100, done: true }, "/b.mkv": { error: true } },
  });
});

test("a second batch cannot start while one is running, and cancel stops after the current file", async () => {
  let release: () => void = () => {};
  const gate = new Promise<TranscribeResponse>((resolve) => { release = () => resolve(response); });
  const sent: string[] = [];
  const first = runBatch({
    paths: ["/a.mkv", "/b.mkv", "/c.mkv"],
    request,
    transcribe: (req) => { sent.push(req.videoPath); return gate; },
    onFileError: () => {},
    onFinished: () => {},
  });
  await Promise.resolve();
  assert.equal(getBatchState().running, true);
  assert.equal(getBatchState().activePath, "/a.mkv");

  let secondFinished = false;
  await runBatch({ paths: ["/z.mkv"], request, transcribe: async () => response, onFileError: () => {}, onFinished: () => { secondFinished = true; } });
  assert.equal(secondFinished, false);
  assert.equal(getBatchState().progress?.total, 3);

  await cancelBatch({ cancelOne: async () => {}, cancelAll: async () => {} });
  release();
  await first;
  assert.deepEqual(sent, ["/a.mkv"]);
  assert.equal(getBatchState().running, false);
  assert.deepEqual(getBatchState().fileProgress, { "/a.mkv": { pct: 100, done: true } });
});

test("cancelBatch cancels the active file and everything else in flight", async () => {
  let release: () => void = () => {};
  const gate = new Promise<TranscribeResponse>((resolve) => { release = () => resolve(response); });
  const run = runBatch({
    paths: ["/a.mkv"],
    request,
    transcribe: () => gate,
    onFileError: () => {},
    onFinished: () => {},
  });
  await Promise.resolve();
  const cancelledPaths: string[] = [];
  let allCount = 0;
  await cancelBatch({
    cancelOne: async (path) => { cancelledPaths.push(path); },
    cancelAll: async () => { allCount += 1; },
  });
  release();
  await run;
  assert.deepEqual(cancelledPaths, ["/a.mkv"]);
  assert.equal(allCount, 1);
});

test("cancelBatch with no owned batch still stops the server-side runs", async () => {
  let allCount = 0;
  await cancelBatch({ cancelAll: async () => { allCount += 1; } });
  assert.equal(allCount, 1);
});

test("hasLiveTranscriptions sees live runs and ignores settled ones", () => {
  assert.equal(hasLiveTranscriptions({ "/a.mkv": { pct: 40 } }), true);
  assert.equal(hasLiveTranscriptions({ "/a.mkv": { phase: "loading" } }), true);
  assert.equal(hasLiveTranscriptions({ "/a.mkv": { pct: 99, done: true } }), false);
  assert.equal(hasLiveTranscriptions({ "/a.mkv": { error: true } }), false);
  assert.equal(hasLiveTranscriptions({ "/a.mkv": { cancelled: true } }), false);
  assert.equal(hasLiveTranscriptions({}), false);
});
