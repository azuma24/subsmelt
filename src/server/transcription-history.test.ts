import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptionHistoryStore, summarizeTranscriptionError } from "./transcription-history.js";

test("summarizeTranscriptionError redacts filesystem paths", () => {
  const summary = summarizeTranscriptionError("Failed to open /private/tmp/video/Episode 01.mkv because /Users/alice/media is missing");
  assert.equal(summary.includes("/private/tmp/video"), false);
  assert.equal(summary.includes("/Users/alice/media"), false);
  assert.match(summary, /\[path\]/);
});

test("history store records attempts and keeps newest entries first", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-history-test-"));
  const store = new TranscriptionHistoryStore(path.join(tmpDir, "transcription-history.json"));

  const started = store.startAttempt({
    inputPath: "/media/show/Episode 01.mkv",
    outputPath: "/media/show/Episode 01.srt",
    model: "small",
    language: "ja",
    outputFormat: "srt",
    postAction: "transcribe_only",
  });
  store.finishAttempt(started.id, {
    status: "succeeded",
    finishedAt: "2026-05-01T10:00:05.000Z",
    durationSeconds: 5,
  });

  const failed = store.startAttempt({
    inputPath: "/media/show/Episode 02.mkv",
    outputPath: "/media/show/Episode 02.srt",
    model: "small",
    language: "auto",
    outputFormat: "srt",
    postAction: "transcribe_and_translate",
  });
  store.finishAttempt(failed.id, {
    status: "failed",
    finishedAt: "2026-05-01T11:00:00.000Z",
    errorSummary: summarizeTranscriptionError("Boom at /private/tmp/subsmelt-stt-history-quality/media/Episode 02.mkv"),
  });

  const recent = store.listRecent();
  assert.equal(recent.length, 2);
  assert.equal(recent[0]?.id, failed.id);
  assert.equal(recent[0]?.status, "failed");
  assert.equal(recent[0]?.errorSummary?.includes("/private/tmp"), false);
  assert.equal(recent[1]?.status, "succeeded");
  assert.equal(recent[1]?.durationSeconds, 5);
});

test("clear removes finished attempts and keeps running ones", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-history-clear-"));
  const filePath = path.join(tmpDir, "transcription-history.json");
  const store = new TranscriptionHistoryStore(filePath);

  const done = store.startAttempt({
    inputPath: "/media/show/Episode 05.mkv",
    outputPath: "/media/show/Episode 05.srt",
    model: "small",
    language: "auto",
    outputFormat: "srt",
    postAction: "transcribe_only",
  });
  store.finishAttempt(done.id, { status: "succeeded", durationSeconds: 4 });
  const running = store.startAttempt({
    inputPath: "/media/show/Episode 06.mkv",
    outputPath: "/media/show/Episode 06.srt",
    model: "small",
    language: "auto",
    outputFormat: "srt",
    postAction: "transcribe_only",
  });

  assert.equal(store.clear(), 1);
  assert.equal(store.get(done.id), undefined);
  assert.equal(store.get(running.id)?.status, "running");
  // Clearing again is a no-op while the running attempt is still in flight.
  assert.equal(store.clear(), 0);
});

test("remove deletes a single attempt and reports unknown ids", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-history-remove-"));
  const store = new TranscriptionHistoryStore(path.join(tmpDir, "transcription-history.json"));

  const first = store.startAttempt({
    inputPath: "/media/show/Episode 07.mkv",
    outputPath: "/media/show/Episode 07.srt",
    model: "small",
    language: "auto",
    outputFormat: "srt",
    postAction: "transcribe_only",
  });
  const second = store.startAttempt({
    inputPath: "/media/show/Episode 08.mkv",
    outputPath: "/media/show/Episode 08.srt",
    model: "small",
    language: "auto",
    outputFormat: "srt",
    postAction: "transcribe_only",
  });
  store.finishAttempt(first.id, { status: "failed", errorSummary: "nope" });

  assert.equal(store.remove(first.id), true);
  assert.equal(store.get(first.id), undefined);
  assert.equal(store.remove(first.id), false);
  assert.equal(store.listRecent().length, 1);
  assert.equal(store.listRecent()[0]?.id, second.id);
});

test("reconcileRunning marks lingering running attempts as failed", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-history-reconcile-"));
  const store = new TranscriptionHistoryStore(path.join(tmpDir, "transcription-history.json"));

  const running = store.startAttempt({
    inputPath: "/media/show/Episode 03.mkv",
    outputPath: "/media/show/Episode 03.srt",
    model: "small",
    language: "auto",
    outputFormat: "srt",
    postAction: "transcribe_only",
  });
  const done = store.startAttempt({
    inputPath: "/media/show/Episode 04.mkv",
    outputPath: "/media/show/Episode 04.srt",
    model: "small",
    language: "auto",
    outputFormat: "srt",
    postAction: "transcribe_only",
  });
  store.finishAttempt(done.id, { status: "succeeded", durationSeconds: 3 });

  const reconciled = store.reconcileRunning();
  assert.equal(reconciled, 1);

  const after = store.get(running.id);
  assert.equal(after?.status, "failed");
  assert.ok(after?.finishedAt);
  assert.match(after?.errorSummary || "", /interrupted/i);

  // Succeeded entry untouched; second reconcile is a no-op.
  assert.equal(store.get(done.id)?.status, "succeeded");
  assert.equal(store.reconcileRunning(), 0);
});
