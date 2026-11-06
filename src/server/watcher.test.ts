import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-watcher-"));
const media = path.join(root, "media");
fs.mkdirSync(media);
process.env.MEDIA_DIR = media;
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
const config = await import("./config.js");
const db = await import("./db.js");
const { getWatcherStatus, setWatcherEnabled } = await import("./watcher.js");
const { transcriptionWork } = await import("./transcription/work.js");

async function waitUntil(predicate: () => boolean, timeout: number) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(50);
  assert.ok(predicate());
}

test("file events queue translation and missing-subtitle transcription through one scan", {
  timeout: 20000,
}, async (t) => {
  t.after(() => setWatcherEnabled(false));
  t.mock.method(transcriptionWork, "start", () => {});
  for (const task of config.getTasks()) config.deleteTask(task.id);
  config.createTask({
    source_lang: config.AUTO_SOURCE_LANGUAGE,
    target_lang: "zh",
    output_pattern: "{{name}}.zh.srt",
    lang_code: "zh",
  });
  config.setSettings({
    translate_without_video: "off",
    auto_translate: "0",
    transcription_enabled: "1",
    transcription_backend_url: "http://127.0.0.1:9",
    transcription_missing_subtitle_behavior: "auto_transcribe_and_translate",
  });
  const subtitle = path.join(media, "Arrival.srt");
  fs.writeFileSync(subtitle, "subtitle");
  assert.equal(setWatcherEnabled(true).fileEvents, "starting");
  await waitUntil(() => getWatcherStatus().fileEvents === "watching", 5_000);
  assert.equal(getWatcherStatus().running, true);
  fs.writeFileSync(path.join(media, "Arrival.MKV"), "video");
  const missing = path.join(media, "Missing.mkv");
  fs.writeFileSync(missing, "video");

  await waitUntil(() => transcriptionWork.store.list().some((item) => item.input === missing), 14_000);
  assert.ok(db.getJobs().some((job) => job.srt_path === subtitle));
  assert.equal(
    transcriptionWork.store.list().find((item) => item.input === missing)?.request.postAction,
    "transcribe_and_translate",
  );
});

test("starting without a media directory reports file events unavailable", () => {
  const offline = path.join(root, "offline");
  fs.renameSync(media, offline);
  try {
    assert.deepEqual(setWatcherEnabled(true), {
      enabled: true,
      running: false,
      fileEvents: "unavailable",
      pollIntervalMinutes: 0,
    });
  } finally {
    setWatcherEnabled(false);
    fs.renameSync(offline, media);
  }
});
