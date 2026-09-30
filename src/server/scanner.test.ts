import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// scanner.ts reads MEDIA_DIR, db.ts opens DATA_DIR and config.ts loads CONFIG_DIR
// at import, so point all three at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-scan-"));
const mediaDir = path.join(root, "media");
fs.mkdirSync(mediaDir);
process.env.MEDIA_DIR = mediaDir;
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
const config = await import("./config.js");
const db = await import("./db.js");
const { scanFolder } = await import("./scanner.js");

function library(name: string, files: string[]): string {
  const dir = path.join(mediaDir, name);
  fs.mkdirSync(dir);
  for (const file of files) fs.writeFileSync(path.join(dir, file), "");
  return dir;
}

function useTasks(...langCodes: string[]): void {
  for (const task of [...config.getTasks()]) config.deleteTask(task.id);
  for (const langCode of langCodes) {
    config.createTask({
      source_lang: config.AUTO_SOURCE_LANGUAGE,
      target_lang: langCode,
      output_pattern: `{{name}}.${langCode}.srt`,
      lang_code: langCode,
    });
  }
}

/** Runs a real scan and returns the subtitle names grouped under each video in `dir`. */
function scan(dir: string): Record<string, string[]> {
  const { files } = scanFolder(true);
  return Object.fromEntries(
    files
      .filter((file) => file.videoPath?.startsWith(`${dir}${path.sep}`))
      .map((file) => [file.videoName, file.subtitles.map((sub) => sub.srtName)]),
  );
}

/** Jobs queued for subtitles in `dir`, as [source, output] file names. */
function jobsIn(dir: string): string[][] {
  return db
    .getJobs()
    .filter((job) => path.dirname(job.srt_path) === dir)
    .map((job) => [path.basename(job.srt_path), path.basename(job.output_path)])
    .sort();
}

test("a source whose name only resembles a task output is still translated", () => {
  useTasks("zh");
  const dir = library("resembles-output", [
    "Movie.mkv",
    "Movie.srt",
    "Movie.zh.srt",
    "Movie.v2.mkv",
    "Movie.v2.srt",
  ]);

  assert.deepEqual(scan(dir), {
    "Movie.mkv": ["Movie.srt"],
    "Movie.v2.mkv": ["Movie.v2.srt"],
  });
  assert.deepEqual(jobsIn(dir), [["Movie.v2.srt", "Movie.v2.zh.srt"]]);
});

test("a subtitle counts as a task output only when a sibling subtitle would produce it", () => {
  useTasks("eng", "zh");
  const dir = library("lone-lang-suffix", ["Film.mkv", "Film.eng.srt"]);

  assert.deepEqual(scan(dir), { "Film.mkv": ["Film.eng.srt"] });
  assert.deepEqual(jobsIn(dir), [["Film.eng.srt", "Film.zh.srt"]]);
});
