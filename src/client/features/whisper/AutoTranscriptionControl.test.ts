import { test } from "node:test";
import assert from "node:assert/strict";
import { autoTranscriptionPatch } from "./AutoTranscriptionControl.js";

test("enabling automatic transcription also enables periodic server scans", () => {
  assert.deepEqual(autoTranscriptionPatch("auto_transcribe", "0"), {
    transcription_missing_subtitle_behavior: "auto_transcribe",
    auto_scan_interval: "30",
  });
  assert.deepEqual(autoTranscriptionPatch("auto_transcribe_and_translate", ""), {
    transcription_missing_subtitle_behavior: "auto_transcribe_and_translate",
    auto_scan_interval: "30",
  });
});

test("existing scan cadence survives changing transcription behavior", () => {
  assert.deepEqual(autoTranscriptionPatch("auto_transcribe", "120"), {
    transcription_missing_subtitle_behavior: "auto_transcribe",
  });
  assert.deepEqual(autoTranscriptionPatch("ask", "120"), {
    transcription_missing_subtitle_behavior: "ask",
  });
});
