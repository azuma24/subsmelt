import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-watcher-"));
const media = path.join(root, "media");
fs.mkdirSync(media);
process.env.MEDIA_DIR = media;
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
const config = await import("./config.js");
const db = await import("./db.js");
const { startWatcher, stopWatcher } = await import("./watcher.js");

test("a video arriving after its subtitle triggers a scan and creates a job", { timeout: 20000 }, async (t) => {
  t.after(() => stopWatcher());
  for (const task of config.getTasks()) config.deleteTask(task.id);
  config.createTask({
    source_lang: config.AUTO_SOURCE_LANGUAGE,
    target_lang: "zh",
    output_pattern: "{{name}}.zh.srt",
    lang_code: "zh",
  });
  config.setSetting("translate_without_video", "off");
  config.setSetting("auto_translate", "0");
  const subtitle = path.join(media, "Arrival.srt");
  fs.writeFileSync(subtitle, "subtitle");
  startWatcher();
  // Wait for chokidar's initial crawl before adding the video.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  fs.writeFileSync(path.join(media, "Arrival.MKV"), "video");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !db.getJobs().some((job) => job.srt_path === subtitle)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(db.getJobs().some((job) => job.srt_path === subtitle));
});
