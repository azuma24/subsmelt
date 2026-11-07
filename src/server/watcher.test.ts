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
const { scanAndEnqueue } = await import("./library-scan.js");
const { transcriptionWork } = await import("./transcription/work.js");

async function waitUntil(predicate: () => boolean, timeout: number) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(50);
  assert.ok(predicate());
}

test("file events queue subtitles and transcribe only videos that have settled", {
  timeout: 30_000,
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
  const growing = path.join(media, "Growing.mkv");
  fs.writeFileSync(growing, "video");
  const copying = setInterval(() => fs.appendFileSync(growing, "more data"), 100);
  const queued = (input: string) => transcriptionWork.store.list().some((item) => item.input === input);
  try {
    await waitUntil(() => queued(missing), 14_000);
    assert.equal(queued(growing), false);
  } finally {
    clearInterval(copying);
  }
  await waitUntil(() => queued(growing), 14_000);
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

function addMedia(name: string, directory = media): string {
  fs.writeFileSync(path.join(directory, `${name}.mkv`), "video");
  const subtitle = path.join(directory, `${name}.srt`);
  fs.writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:03,000\nText\n");
  return subtitle;
}

const hasJob = (subtitle: string) => db.getJobs().some((job) => job.srt_path === subtitle);

test("file-only monitoring catches up on files created while paused", { timeout: 15_000 }, async (t) => {
  t.after(() => setWatcherEnabled(false));
  config.setSettings({ transcription_enabled: "0" });
  setWatcherEnabled(true);
  await waitUntil(() => getWatcherStatus().running, 3_000);
  setWatcherEnabled(false);
  await delay(750);
  const subtitle = addMedia("During pause");
  await delay(1_250);
  assert.equal(hasJob(subtitle), false);

  setWatcherEnabled(true);
  await waitUntil(() => hasJob(subtitle), 10_000);
});

test("a directory permission error leaves sibling monitoring active and recovers the child", {
  timeout: 30_000,
}, async (t) => {
  const directory = path.join(media, "Permission denied");
  fs.mkdirSync(directory);
  const restored = addMedia("Restored", directory);
  t.after(() => {
    setWatcherEnabled(false);
    fs.chmodSync(directory, 0o700);
  });
  fs.chmodSync(directory, 0);
  try {
    fs.readdirSync(directory);
    return t.skip("The test user can read the fixture regardless of permissions");
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "EACCES");
  }

  setWatcherEnabled(true);
  await waitUntil(() => getWatcherStatus().running, 5_000);
  const sibling = addMedia("Sibling");
  await waitUntil(() => hasJob(sibling), 10_000);
  assert.equal(hasJob(restored), false);

  fs.chmodSync(directory, 0o700);
  await waitUntil(() => hasJob(restored), 16_000);
  assert.equal(getWatcherStatus().running, true);
});

test("pausing an in-flight poll prevents new jobs and preserves a concurrent manual scan", async (t) => {
  config.setSettings({ watch_enabled: "0", auto_scan_interval: "1", transcription_enabled: "0" });
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => {
    setWatcherEnabled(false);
    t.mock.timers.reset();
  });

  let markEntered!: () => void;
  let resumeRead!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resumeRead = resolve;
  });
  const read = fs.promises.readdir;
  let reads = 0;
  let subtitle: string | undefined;
  t.mock.method(fs.promises, "readdir", async (...args: Parameters<typeof read>) => {
    if (args[0] === media) {
      reads++;
      if (reads === 1) {
        markEntered();
        await blocked;
      } else if (subtitle) {
        assert.equal(hasJob(subtitle), false);
      }
    }
    return read(...args);
  });

  setWatcherEnabled(true);
  t.mock.timers.tick(60_000);
  await entered;
  const manual = scanAndEnqueue();
  setWatcherEnabled(false);
  assert.equal(getWatcherStatus().running, false);
  subtitle = addMedia("After pause");
  resumeRead();

  assert.equal((await manual).newJobs, 1);
  assert.equal(reads, 2);
  assert.ok(hasJob(subtitle));
});
