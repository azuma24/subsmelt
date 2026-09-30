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
const { scanFolder, stripLangSuffix, parseFolderSetting } = await import(
  "./scanner.js"
);

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
      .map((file) => [
        file.videoName,
        file.subtitles.map((sub) => sub.srtName).sort(),
      ]),
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

test("two sources that translate to one output queue one job, from the source without a language suffix", () => {
  useTasks("zh");
  const dir = library("shared-output", ["Show.mkv", "Show.eng.srt", "Show.srt"]);

  scan(dir);
  scan(dir);

  assert.deepEqual(jobsIn(dir), [["Show.srt", "Show.zh.srt"]]);
  const scanLogs = db.getLogs({ category: "scan" }).map((log) => log.message);
  assert.ok(
    scanLogs.some((message) => message.includes("Skipped Show.eng.srt")),
    `no skip logged in ${JSON.stringify(scanLogs)}`,
  );
});

test("stripLangSuffix drops a language with an optional region or subtitle flag", () => {
  assert.equal(stripLangSuffix("Movie.en"), "Movie");
  assert.equal(stripLangSuffix("Movie.en.sdh"), "Movie");
  assert.equal(stripLangSuffix("Movie.en.forced"), "Movie");
  assert.equal(stripLangSuffix("Movie.eng.cc"), "Movie");
  assert.equal(stripLangSuffix("Movie.en.hi"), "Movie");
  assert.equal(stripLangSuffix("Movie.zh-TW"), "Movie");
  assert.equal(stripLangSuffix("Movie.pt-BR.forced"), "Movie");
  assert.equal(stripLangSuffix("Movie.v2"), "Movie.v2");
  assert.equal(stripLangSuffix("Movie.sdh"), "Movie.sdh");
  assert.equal(stripLangSuffix("Movie.hi"), "Movie.hi");
  assert.equal(stripLangSuffix("en.sdh"), "en.sdh");
});

test("flagged and region-coded subtitles match their video, and the full subtitle owns the shared output", () => {
  useTasks("zh");
  const dir = library("flags-and-regions", [
    "Movie.mkv",
    "Movie.en.srt",
    "Movie.en.forced.srt",
    "Drama.mkv",
    "Drama.zh-TW.srt",
  ]);

  assert.deepEqual(scan(dir), {
    "Drama.mkv": ["Drama.zh-TW.srt"],
    "Movie.mkv": ["Movie.en.forced.srt", "Movie.en.srt"],
  });
  assert.deepEqual(jobsIn(dir), [
    ["Drama.zh-TW.srt", "Drama.zh.srt"],
    ["Movie.en.srt", "Movie.zh.srt"],
  ]);
});

test("a folder setting stored as a JSON array keeps commas inside folder names", () => {
  assert.deepEqual(parseFolderSetting('["Movies, 2024","TV"]'), ["Movies, 2024", "TV"]);
  assert.deepEqual(parseFolderSetting('[" Anime ", "", "TV"]'), ["Anime", "TV"]);
});

test("a folder setting stored as the legacy comma list still parses", () => {
  assert.deepEqual(parseFolderSetting("Movies,TV"), ["Movies", "TV"]);
  assert.deepEqual(parseFolderSetting(" Movies , ,TV "), ["Movies", "TV"]);
  assert.deepEqual(parseFolderSetting("   "), []);
  assert.deepEqual(parseFolderSetting('"abc"'), ['"abc"']);
  assert.deepEqual(parseFolderSetting("{}"), ["{}"]);
  assert.deepEqual(parseFolderSetting("[Anime],TV"), ["[Anime]", "TV"]);
});

test("a selected folder whose name contains a comma is scanned", (t) => {
  useTasks("zh");
  const dir = library("Movies, 2024", ["Film.mkv", "Film.srt"]);
  config.setSetting("scan_mode", "selected");
  config.setSetting("scan_folders", JSON.stringify(["Movies, 2024"]));
  t.after(() => {
    config.setSetting("scan_mode", "recursive");
    config.setSetting("scan_folders", "");
  });

  assert.deepEqual(scan(dir), { "Film.mkv": ["Film.srt"] });
});
