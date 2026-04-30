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
