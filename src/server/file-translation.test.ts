import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// scanner.ts reads MEDIA_DIR, db.ts opens DATA_DIR and config.ts loads CONFIG_DIR
// at import, so point all three at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-file-translation-"));
const mediaDir = path.join(root, "media");
fs.mkdirSync(mediaDir);
process.env.MEDIA_DIR = mediaDir;
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
const config = await import("./config.js");
const db = await import("./db.js");
const { scanFolder } = await import("./scanner.js");
const { queueFileTranslation } = await import("./file-translation.js");

function library(name: string, files: string[]): string {
  const dir = path.join(mediaDir, name);
  fs.mkdirSync(dir);
  for (const file of files) fs.writeFileSync(path.join(dir, file), "");
  return dir;
}

function taskSummaries(): string[] {
  return config.getTasks().map((t) => `${t.lang_code}:${t.target_lang}:${t.enabled}:${t.output_pattern}`);
}

test("a new language creates one disabled task and a pending job; asking again reports the same job", () => {
  const dir = library("new-lang", ["Movie.mkv", "Movie.en.srt"]);
  const srtPath = path.join(dir, "Movie.en.srt");

  const first = queueFileTranslation(srtPath, { langCode: "fr", targetLang: "French" });
  const second = queueFileTranslation(srtPath, { langCode: "fr", targetLang: "French" });

  assert.equal(first.kind, "queued");
  assert.ok(first.kind === "queued");
  assert.deepEqual(second, { kind: "already-queued", jobId: first.jobId, taskId: first.taskId });
  assert.deepEqual(taskSummaries(), [
    "eng:English:1:{{name}}.{{lang_code}}.srt",
    "fra:French:0:{{name}}.{{lang_code}}.srt",
  ]);
  const job = db.getJob(first.jobId);
  assert.deepEqual(
    { status: job?.status, output: job?.output_path, video: job?.video_path, task: job?.task_id },
    {
      status: "pending",
      output: path.join(dir, "Movie.fra.srt"),
      video: path.join(dir, "Movie.mkv"),
      task: first.taskId,
    },
  );
});

test("a language that already has a task reuses it, whatever the spelling", () => {
  const dir = library("reuse", ["Show.srt"]);
  const before = config.getTasks().length;

  const result = queueFileTranslation(path.join(dir, "Show.srt"), { langCode: "ENG", targetLang: "English" });

  assert.ok(result.kind === "queued");
  assert.equal(result.taskId, 1);
  assert.equal(config.getTasks().length, before);
  // "ENG" is English: the existing task, writing the standard name.
  assert.equal(db.getJob(result.jobId)?.output_path, path.join(dir, "Show.eng.srt"));
  assert.equal(db.getJob(result.jobId)?.video_path, null);
});

test("an output already on disk, a path outside the media folder or a non-subtitle file is refused", () => {
  const dir = library("refused", ["Film.srt", "Film.de.srt", "Film.mkv"]);
  const outside = path.join(root, "Outside.srt");
  fs.writeFileSync(outside, "");
  const tasksBefore = taskSummaries();

  assert.deepEqual(queueFileTranslation(path.join(dir, "Film.srt"), { langCode: "de", targetLang: "German" }), {
    kind: "rejected",
    status: 409,
    error: "Film.de.srt already exists",
  });
  assert.deepEqual(taskSummaries(), tasksBefore);
  assert.deepEqual(queueFileTranslation(outside, { taskId: 1 }), {
    kind: "rejected",
    status: 400,
    error: "Subtitle must be inside the media folder",
  });
  assert.deepEqual(queueFileTranslation(path.join(dir, "Film.mkv"), { taskId: 1 }), {
    kind: "rejected",
    status: 400,
    error: "File is not a subtitle",
  });
  assert.deepEqual(queueFileTranslation(path.join(dir, "Gone.srt"), { taskId: 1 }), {
    kind: "rejected",
    status: 404,
    error: "Subtitle file not found",
  });
  assert.deepEqual(queueFileTranslation(path.join(dir, "Film.srt"), { taskId: 999 }), {
    kind: "rejected",
    status: 404,
    error: "Translation task not found",
  });
});

test("a failed job is reset to pending; a finished one is refused", () => {
  const dir = library("retry", ["Clip.srt", "Done.srt"]);
  const failed = db.createJob({
    task_id: 1,
    srt_path: path.join(dir, "Clip.srt"),
    output_path: path.join(dir, "Clip.eng.srt"),
    video_path: null,
    status: "error",
  });
  db.createJob({
    task_id: 1,
    srt_path: path.join(dir, "Done.srt"),
    output_path: path.join(dir, "Done.eng.srt"),
    video_path: null,
    status: "done",
  });

  const result = queueFileTranslation(path.join(dir, "Clip.srt"), { taskId: 1 });

  assert.deepEqual(result, { kind: "queued", jobId: Number(failed.lastInsertRowid), taskId: 1 });
  assert.equal(db.getJob(Number(failed.lastInsertRowid))?.status, "pending");
  assert.deepEqual(queueFileTranslation(path.join(dir, "Done.srt"), { taskId: 1 }), {
    kind: "rejected",
    status: 409,
    error: "Done.srt is already translated to eng; use re-translate on its job instead",
  });
});

test("a scan shows the one-off task on its subtitle, never lists its output as a source, and applies it nowhere else", async () => {
  const dir = library("scan", ["Ep1.mkv", "Ep1.srt", "Ep2.mkv", "Ep2.srt"]);
  const queued = queueFileTranslation(path.join(dir, "Ep1.srt"), { langCode: "it", targetLang: "Italian" });
  assert.ok(queued.kind === "queued");
  // The translation finished: its output now sits beside the source.
  fs.writeFileSync(path.join(dir, "Ep1.ita.srt"), "");
  db.updateJob(queued.jobId, { status: "done" });

  const { files } = await scanFolder(true);

  const inDir = files.filter((file) => file.videoPath?.startsWith(`${dir}${path.sep}`));
  assert.deepEqual(
    inDir.map((file) => ({
      video: file.videoName,
      subtitles: file.subtitles.map((sub) => ({
        name: sub.srtName,
        tasks: sub.tasks.map((task) => `${task.langCode}:${task.status}`),
      })),
    })),
    [
      { video: "Ep1.mkv", subtitles: [{ name: "Ep1.srt", tasks: ["eng:pending", "ita:done"] }] },
      { video: "Ep2.mkv", subtitles: [{ name: "Ep2.srt", tasks: ["eng:pending"] }] },
    ],
  );
  assert.deepEqual(
    db
      .getJobs()
      .filter((job) => job.task_id === queued.taskId)
      .map((job) => path.basename(job.srt_path)),
    ["Ep1.srt"],
  );
});

test("a failed job reset after its task's naming changed writes to the new output path", () => {
  const dir = library("renamed", ["Ep.srt"]);
  const taskId = config.createTask({
    source_lang: "Automatic",
    target_lang: "Japanese",
    output_pattern: "{{name}}.{{lang_code}}.srt",
    lang_code: "jpn",
    enabled: 0,
  }).lastInsertRowid;
  const failed = Number(
    db.createJob({
      task_id: taskId,
      srt_path: path.join(dir, "Ep.srt"),
      output_path: path.join(dir, "Ep.jpn.srt"),
      video_path: null,
      status: "error",
    }).lastInsertRowid,
  );
  config.updateTask(taskId, { lang_code: "ja", output_pattern: "{{name}}.{{lang_code}}.subs.srt" });

  const result = queueFileTranslation(path.join(dir, "Ep.srt"), { taskId });

  assert.deepEqual(result, { kind: "queued", jobId: failed, taskId });
  const job = db.getJob(failed);
  assert.deepEqual(
    { status: job?.status, output: job?.output_path },
    { status: "pending", output: path.join(dir, "Ep.jpn.subs.srt") },
  );
});

test("switching the preferred Chinese moves the Chinese tasks at once, so Simplified can be added before a restart", (t) => {
  t.after(() => config.setSetting("preferred_chinese", "zh-TW"));
  config.setSetting("preferred_chinese", "zh-TW");
  const traditionalId = config.createTask({
    source_lang: "Automatic",
    target_lang: "Traditional Chinese",
    output_pattern: "{{name}}.{{lang_code}}.srt",
    lang_code: "zh-TW",
  }).lastInsertRowid;
  assert.equal(config.getTask(traditionalId)?.lang_code, "chi");
  const dir = library("switch-chinese", ["Fresh.mkv", "Fresh.en.srt", "Old.mkv", "Old.en.srt", "Old.chi.srt"]);

  config.setSetting("preferred_chinese", "zh-CN");
  assert.equal(config.getTask(traditionalId)?.lang_code, "cht");

  // .chi now names Simplified: a Simplified translation is queued under it...
  const fresh = queueFileTranslation(path.join(dir, "Fresh.en.srt"), {
    langCode: "zh-CN",
    targetLang: "Simplified Chinese",
  });
  assert.ok(fresh.kind === "queued", JSON.stringify(fresh));
  assert.equal(db.getJob(fresh.jobId)?.output_path, path.join(dir, "Fresh.chi.srt"));
  // ...an existing .chi counts as the Simplified one, not as the Traditional task's former code...
  const old = queueFileTranslation(path.join(dir, "Old.en.srt"), {
    langCode: "zh-CN",
    targetLang: "Simplified Chinese",
  });
  assert.deepEqual(old, { kind: "rejected", status: 409, error: "Old.chi.srt already exists" });
  // ...and the Traditional task writes .cht.
  const traditional = queueFileTranslation(path.join(dir, "Old.en.srt"), { taskId: traditionalId });
  assert.ok(traditional.kind === "queued", JSON.stringify(traditional));
  assert.equal(db.getJob(traditional.jobId)?.output_path, path.join(dir, "Old.cht.srt"));

  // Switching back gives Traditional .chi again and Simplified .chs.
  config.setSetting("preferred_chinese", "zh-TW");
  assert.equal(config.getTask(traditionalId)?.lang_code, "chi");
  assert.equal(config.getTask(fresh.taskId)?.lang_code, "chs");
});
