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
const { scanFolder, standardOutputFor, stripLangSuffix, parseFolderSetting, findAnyCase, outputNameFor } = await import(
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
async function scan(dir: string): Promise<Record<string, string[]>> {
  const { files } = await scanFolder(true);
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

test("a source whose name only resembles a task output is still translated", async () => {
  useTasks("zh");
  const dir = library("resembles-output", [
    "Movie.mkv",
    "Movie.srt",
    "Movie.zh.srt",
    "Movie.v2.mkv",
    "Movie.v2.srt",
  ]);

  assert.deepEqual(await scan(dir), {
    "Movie.mkv": ["Movie.srt"],
    "Movie.v2.mkv": ["Movie.v2.srt"],
  });
  assert.deepEqual(jobsIn(dir), [["Movie.v2.srt", "Movie.v2.zh.srt"]]);
});

test("a subtitle counts as a task output only when a sibling subtitle would produce it", async () => {
  useTasks("eng", "zh");
  const dir = library("lone-lang-suffix", ["Film.mkv", "Film.eng.srt"]);

  assert.deepEqual(await scan(dir), { "Film.mkv": ["Film.eng.srt"] });
  assert.deepEqual(jobsIn(dir), [["Film.eng.srt", "Film.zh.srt"]]);
});

test("two sources that translate to one output queue one job, from the source without a language suffix", async () => {
  useTasks("zh");
  const dir = library("shared-output", ["Show.mkv", "Show.eng.srt", "Show.srt"]);

  await scan(dir);
  await scan(dir);

  assert.deepEqual(jobsIn(dir), [["Show.srt", "Show.zh.srt"]]);
  const scanLogs = db.getLogs({ category: "scan" }).map((log) => log.message);
  assert.ok(
    scanLogs.some((message) => message.includes("Skipped Show.eng.srt")),
    `no skip logged in ${JSON.stringify(scanLogs)}`,
  );
});

test("stripLangSuffix drops a language with an optional region or subtitle flag", async () => {
  assert.equal(stripLangSuffix("Movie.en"), "Movie");
  assert.equal(stripLangSuffix("Movie.en.sdh"), "Movie");
  assert.equal(stripLangSuffix("Movie.en.forced"), "Movie");
  assert.equal(stripLangSuffix("Movie.eng.cc"), "Movie");
  assert.equal(stripLangSuffix("Movie.en.hi"), "Movie");
  assert.equal(stripLangSuffix("Movie.zh-TW"), "Movie");
  assert.equal(stripLangSuffix("Movie.pt-BR.forced"), "Movie");
  assert.equal(stripLangSuffix("Movie.v2"), "Movie.v2");
  assert.equal(stripLangSuffix("Movie.sdh"), "Movie.sdh");
  // Alone, "hi" is Hindi's code (what a Hindi task writes); after a language it is the hearing-impaired flag.
  assert.equal(stripLangSuffix("Movie.hi"), "Movie");
  assert.equal(stripLangSuffix("en.sdh"), "en.sdh");
});

test("every code a task can write is read back as a language suffix", async () => {
  for (const code of ["en", "ko", "ja", "zh-TW", "zh-CN", "es", "fr", "de", "pt", "ru", "ar", "th", "vi", "id", "nl", "pl", "tr", "hi", "uk", "sv"]) {
    assert.equal(stripLangSuffix(`Movie.${code}`), "Movie", code);
  }
  for (const old of ["swe", "ukr", "hin", "tur", "pol", "nld", "ind"]) assert.equal(stripLangSuffix(`Movie.${old}`), "Movie", old);
});

test("flagged and region-coded subtitles match their video, and the full subtitle owns the shared output", async () => {
  useTasks("zh");
  const dir = library("flags-and-regions", [
    "Movie.mkv",
    "Movie.en.srt",
    "Movie.en.forced.srt",
    "Drama.mkv",
    "Drama.zh-TW.srt",
  ]);

  assert.deepEqual(await scan(dir), {
    "Drama.mkv": ["Drama.zh-TW.srt"],
    "Movie.mkv": ["Movie.en.forced.srt", "Movie.en.srt"],
  });
  assert.deepEqual(jobsIn(dir), [
    ["Drama.zh-TW.srt", "Drama.zh.srt"],
    ["Movie.en.srt", "Movie.zh.srt"],
  ]);
});

test("with no enabled task a video's subtitle is still listed, with no languages and no job", async () => {
  useTasks();
  const dir = library("no-targets", ["Movie.mkv", "Movie.srt"]);

  const { files } = await scanFolder(true);
  const movie = files.find((file) => file.videoPath === path.join(dir, "Movie.mkv"));

  assert.deepEqual(movie?.subtitles, [
    { srtPath: path.join(dir, "Movie.srt"), srtName: "Movie.srt", tasks: [] },
  ]);
  assert.deepEqual(jobsIn(dir), []);
});

test("an orphan subtitle is listed with no languages while translate_without_video is off, and gets no job", async () => {
  useTasks("zh");
  const dir = library("orphans", ["Loose.srt"]);

  const { files } = await scanFolder(true);
  const loose = files.find((file) => file.subtitles.some((sub) => sub.srtPath === path.join(dir, "Loose.srt")));

  assert.deepEqual(loose, {
    videoPath: null,
    videoName: null,
    videoMtime: null,
    subtitles: [{ srtPath: path.join(dir, "Loose.srt"), srtName: "Loose.srt", tasks: [] }],
  });
  assert.deepEqual(jobsIn(dir), []);
});

test("a folder setting stored as a JSON array keeps commas inside folder names", async () => {
  assert.deepEqual(parseFolderSetting('["Movies, 2024","TV"]'), ["Movies, 2024", "TV"]);
  assert.deepEqual(parseFolderSetting('[" Anime ", "", "TV"]'), ["Anime", "TV"]);
});

test("a folder setting stored as the legacy comma list still parses", async () => {
  assert.deepEqual(parseFolderSetting("Movies,TV"), ["Movies", "TV"]);
  assert.deepEqual(parseFolderSetting(" Movies , ,TV "), ["Movies", "TV"]);
  assert.deepEqual(parseFolderSetting("   "), []);
  assert.deepEqual(parseFolderSetting('"abc"'), ['"abc"']);
  assert.deepEqual(parseFolderSetting("{}"), ["{}"]);
  assert.deepEqual(parseFolderSetting("[Anime],TV"), ["[Anime]", "TV"]);
});

test("a selected folder whose name contains a comma is scanned", async (t) => {
  useTasks("zh");
  const dir = library("Movies, 2024", ["Film.mkv", "Film.srt"]);
  config.setSetting("scan_mode", "selected");
  config.setSetting("scan_folders", JSON.stringify(["Movies, 2024"]));
  t.after(() => {
    config.setSetting("scan_mode", "recursive");
    config.setSetting("scan_folders", "");
  });

  assert.deepEqual(await scan(dir), { "Film.mkv": ["Film.srt"] });
});

test("the YouTube download folder is left to its playlists: no jobs, no auto-transcription candidates", async (t) => {
  useTasks("zh");
  config.setSetting("youtube_download_dir", "Tube");
  t.after(() => config.setSetting("youtube_download_dir", "YouTube"));
  const tube = path.join(mediaDir, "Tube", "AI");
  fs.mkdirSync(tube, { recursive: true });
  for (const file of ["Talk [abcdefghijk].mp4", "Talk [abcdefghijk].en.srt", "Silent [bcdefghijkl].mp4"]) fs.writeFileSync(path.join(tube, file), "");
  const shows = library("Tube shows", ["Pilot.mkv", "Pilot.en.srt"]);

  const { files } = await scanFolder(true);

  assert.deepEqual(files.filter((f) => f.videoPath?.includes(`${path.sep}Tube${path.sep}`)), []);
  assert.deepEqual(jobsIn(tube), []);
  assert.deepEqual(jobsIn(shows), [["Pilot.en.srt", "Pilot.zh.srt"]]);
});

test("a scan that finds videos sets the sticky media_scanned flag; an empty scan does not", async (t) => {
  useTasks("zh");
  // Earlier tests in this suite have scanned libraries with videos; the flag
  // is sticky by design, so this test controls its own starting state.
  config.setSetting("media_scanned", "");
  t.after(() => config.setSetting("media_scanned", "1"));
  const dir = library("Flagged", ["Show.mkv", "Show.srt"]);

  await scanFolder(true);
  assert.equal(config.getSetting("media_scanned"), "1");

  // An empty library never un-sets the flag: discovery is "at least once".
  const emptyDir = path.join(mediaDir, "Empty");
  fs.mkdirSync(emptyDir, { recursive: true });
  config.setSetting("scan_folders", JSON.stringify(["Empty"]));
  config.setSetting("scan_mode", "selected");
  await scanFolder(true);
  assert.equal(config.getSetting("media_scanned"), "1");
});

test("an existing output in an old spelling counts as done: no new job, and it is not read as a source", async () => {
  config.setSetting("scan_mode", "recursive");
  config.setSetting("scan_folders", "");
  for (const task of [...config.getTasks()]) config.deleteTask(task.id);
  config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang: "English", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "en" });
  const [english] = config.getTasks();
  assert.equal(english.lang_code, "eng");

  const dir = library("standard-codes", ["Talk.mkv", "Talk.ko.srt", "Talk.en.srt", "Other.mkv", "Other.ko.srt"]);
  assert.deepEqual(await scan(dir), { "Other.mkv": ["Other.ko.srt"], "Talk.mkv": ["Talk.ko.srt"] });
  // Talk already has its English as Talk.en.srt; Other gets the standard name.
  assert.deepEqual(jobsIn(dir), [["Other.ko.srt", "Other.eng.srt"]]);
});

test("a .chi output counts as the preferred Chinese: Traditional by default, not once Simplified is preferred", async (t) => {
  config.setSetting("scan_mode", "recursive");
  config.setSetting("scan_folders", "");
  t.after(() => config.setSetting("preferred_chinese", "zh-TW"));
  const useTraditional = () => {
    for (const task of [...config.getTasks()]) config.deleteTask(task.id);
    config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang: "Traditional Chinese", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "zh-TW" });
    return config.getTasks()[0];
  };

  config.setSetting("preferred_chinese", "zh-TW");
  assert.equal(useTraditional().lang_code, "chi");
  const preferred = library("chinese-preferred", ["Film.mkv", "Film.en.srt", "Film.chi.srt"]);
  assert.deepEqual(await scan(preferred), { "Film.mkv": ["Film.en.srt"] });
  assert.deepEqual(jobsIn(preferred), []);

  config.setSetting("preferred_chinese", "zh-CN");
  assert.equal(useTraditional().lang_code, "cht");
  const other = library("chinese-other", ["Film.mkv", "Film.en.srt", "Film.chi.srt"]);
  await scan(other);
  assert.deepEqual(jobsIn(other).filter(([, output]) => output === "Film.cht.srt").length, 1);
});

test("a queued job written for an older spelling is pointed at the standard name; other paths are kept", async () => {
  const english = { target_lang: "English", lang_code: "eng", output_pattern: "{{name}}.{{lang_code}}.srt", former_lang_codes: ["en"] };
  assert.equal(standardOutputFor("/m/Show.ko.srt", "/m/Show.en.srt", english), "/m/Show.eng.srt");
  assert.equal(standardOutputFor("/m/Show.ko.srt", "/m/Show.eng.srt", english), "/m/Show.eng.srt");
  // A path the task would never write (an edited pattern, a custom name) is left alone.
  assert.equal(standardOutputFor("/m/Show.ko.srt", "/m/elsewhere/Show.txt", english), "/m/elsewhere/Show.txt");
});

test("a file is found under its real name whatever the case asked for, so Linux finds what macOS does", async () => {
  const dir = library("any-case", ["Talk.zh-TW.srt"]);
  assert.equal(findAnyCase(path.join(dir, "Talk.zh-tw.srt")), path.join(dir, "Talk.zh-TW.srt"));
  assert.equal(findAnyCase(path.join(dir, "Talk.zh-TW.srt")), path.join(dir, "Talk.zh-TW.srt"));
  assert.equal(findAnyCase(path.join(dir, "Talk.chs.srt")), null);
});

test("folders whose names differ only in case stay apart; only the file name ignores case", async () => {
  config.setSetting("scan_mode", "recursive");
  config.setSetting("scan_folders", "");
  for (const task of [...config.getTasks()]) config.deleteTask(task.id);
  config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang: "English", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "eng" });
  const upper = library("CaseShow", ["Ep.mkv", "Ep.kor.srt", "Ep.ENG.srt"]);
  const lower = path.join(mediaDir, "caseshow");
  let caseSensitive = true;
  try {
    fs.mkdirSync(lower);
  } catch {
    caseSensitive = false;
  }
  if (caseSensitive) {
    fs.writeFileSync(path.join(lower, "Ep.mkv"), "");
    fs.writeFileSync(path.join(lower, "Ep.kor.srt"), "");
  }
  await scan(upper);
  // Ep.ENG.srt is the English output in its own folder, in any case.
  assert.deepEqual(jobsIn(upper), []);
  if (caseSensitive) assert.deepEqual(jobsIn(lower), [["Ep.kor.srt", "Ep.eng.srt"]]);
});

test("a disabled task's existing translation is still an output, never a second source", async () => {
  config.setSetting("scan_mode", "recursive");
  config.setSetting("scan_folders", "");
  for (const task of [...config.getTasks()]) config.deleteTask(task.id);
  config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang: "English", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "eng", enabled: 0 });
  config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang: "Traditional Chinese (Taiwan)", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "zh-TW" });

  // The library from the bug report: the Korean source, its English and Chinese translations.
  const dir = library("disabled-output", ["Hack.mp4", "Hack.ko.srt", "Hack.eng.srt", "Hack.chi.srt"]);
  assert.deepEqual(await scan(dir), { "Hack.mp4": ["Hack.ko.srt"] });
  assert.deepEqual(jobsIn(dir), []);
});

/** Sets a file's modification time, in seconds since the epoch. */
function touch(dir: string, name: string, seconds: number): void {
  fs.utimesSync(path.join(dir, name), seconds, seconds);
}

/** The status each language shows on `srtName` in the last scan of `dir`. */
async function statusesOf(dir: string, srtName: string): Promise<Record<string, string>> {
  const sub = (await scanFolder(false))
    .files.flatMap((file) => file.subtitles)
    .find((s) => s.srtPath === path.join(dir, srtName));
  return Object.fromEntries((sub?.tasks ?? []).map((task) => [task.langCode, task.status]));
}

function useLanguages(...languages: [string, string][]): void {
  config.setSetting("scan_mode", "recursive");
  config.setSetting("scan_folders", "");
  for (const task of [...config.getTasks()]) config.deleteTask(task.id);
  for (const [target_lang, lang_code] of languages)
    config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang, output_pattern: "{{name}}.{{lang_code}}.srt", lang_code });
}

test("a source and its translation that could each be the other's output: the older file stays the source", async () => {
  useLanguages(["English", "eng"], ["Traditional Chinese", "zh-TW"]);
  const dir = library("mutual-pair", ["Movie.mkv", "Movie.eng.srt", "Movie.chi.srt"]);
  touch(dir, "Movie.eng.srt", 1_000_000);
  touch(dir, "Movie.chi.srt", 2_000_000);

  assert.deepEqual(await scan(dir), { "Movie.mkv": ["Movie.eng.srt"] });
  assert.deepEqual(jobsIn(dir), []);
  assert.equal((await statusesOf(dir, "Movie.eng.srt")).chi, "skipped");

  // The Chinese file came first: it is the source, and the English its translation.
  const reversed = library("mutual-pair-reversed", ["Movie.mkv", "Movie.eng.srt", "Movie.chi.srt"]);
  touch(reversed, "Movie.chi.srt", 1_000_000);
  touch(reversed, "Movie.eng.srt", 2_000_000);
  assert.deepEqual(await scan(reversed), { "Movie.mkv": ["Movie.chi.srt"] });
  assert.deepEqual(jobsIn(reversed), []);
});

test("in a group of translations of one another exactly one file stays the source, even with equal times", async () => {
  useLanguages(["English", "eng"], ["Traditional Chinese", "zh-TW"], ["Korean", "kor"]);
  const dir = library("mutual-three", ["Show.mkv", "Show.eng.srt", "Show.chi.srt", "Show.kor.srt"]);
  touch(dir, "Show.kor.srt", 1_000_000);
  touch(dir, "Show.eng.srt", 2_000_000);
  touch(dir, "Show.chi.srt", 3_000_000);
  assert.deepEqual(await scan(dir), { "Show.mkv": ["Show.kor.srt"] });

  const tied = library("mutual-tied", ["Show.mkv", "Show.eng.srt", "Show.chi.srt"]);
  touch(tied, "Show.eng.srt", 1_000_000);
  touch(tied, "Show.chi.srt", 1_000_000);
  assert.equal((await scan(tied))["Show.mkv"].length, 1);
  // One source, so one Korean job.
  assert.equal(jobsIn(tied).length, 1);
});

test("a video whose extension is upper case still gets its subtitles", async () => {
  useLanguages(["Traditional Chinese", "zh-TW"]);
  const dir = library("upper-ext", ["Movie.MKV", "Movie.eng.srt", "Clip.Mp4", "Clip.srt"]);
  assert.deepEqual(await scan(dir), { "Clip.Mp4": ["Clip.srt"], "Movie.MKV": ["Movie.eng.srt"] });
  const videos = db.getJobs().filter((job) => path.dirname(job.srt_path) === dir).map((job) => path.basename(job.video_path ?? "")).sort();
  assert.deepEqual(videos, ["Clip.Mp4", "Movie.MKV"]);
});

test("dollar signs in a file name are kept in the output name", async () => {
  useLanguages(["Traditional Chinese", "zh-TW"]);
  const dir = library("dollars", ["Ca$$h.2010.mkv", "Ca$$h.2010.eng.srt", "Pay$&Go.mkv", "Pay$&Go.srt", "Tip$'.mkv", "Tip$'.srt"]);
  await scan(dir);
  assert.deepEqual(jobsIn(dir), [
    ["Ca$$h.2010.eng.srt", "Ca$$h.2010.chi.srt"],
    ["Pay$&Go.srt", "Pay$&Go.chi.srt"],
    ["Tip$'.srt", "Tip$'.chi.srt"],
  ]);
  assert.equal(outputNameFor("A$1$$", { output_pattern: "{{name}}.{{lang_code}}.{{ext}}", lang_code: "chi" }, "srt"), "A$1$$.chi.srt");
});

test("a finished job whose output was deleted is queued again; one whose output is still there stays done", async () => {
  useLanguages(["Traditional Chinese", "zh-TW"]);
  const [chinese] = config.getTasks();
  const dir = library("stale-jobs", ["Gone.mkv", "Gone.eng.srt", "Kept.mkv", "Kept.eng.srt", "Kept.chi.srt", "Moved.mkv", "Moved.eng.srt", "Moved.custom.srt", "Skip.mkv", "Skip.eng.srt"]);
  const job = (name: string, output: string, status: string) => {
    const id = Number(db.createJob({ task_id: chinese.id, srt_path: path.join(dir, name), output_path: path.join(dir, output), video_path: null }).lastInsertRowid);
    db.updateJob(id, { status });
    return id;
  };
  const gone = job("Gone.eng.srt", "Gone.chi.srt", "done");
  const kept = job("Kept.eng.srt", "Kept.chi.srt", "done");
  const moved = job("Moved.eng.srt", "Moved.custom.srt", "done");
  const skipped = job("Skip.eng.srt", "Skip.chi.srt", "skipped");

  // A preview scan reports the deleted output as missing without touching the job.
  assert.equal((await statusesOf(dir, "Gone.eng.srt")).chi, "new");
  assert.equal(db.getJob(gone)?.status, "done");

  const { newJobs } = await scanFolder(true);
  assert.equal(newJobs >= 2, true);
  assert.equal(db.getJob(gone)?.status, "pending");
  assert.equal(db.getJob(gone)?.output_path, path.join(dir, "Gone.chi.srt"));
  assert.equal(db.getJob(skipped)?.status, "pending");
  assert.equal(db.getJob(kept)?.status, "done");
  assert.equal(db.getJob(moved)?.status, "done");
});

test("a trailing word that only looks like a language code stays part of the name", async () => {
  assert.equal(stripLangSuffix("Star.Wars.Episode.VI"), "Star.Wars.Episode.VI");
  assert.equal(stripLangSuffix("Rocky.II"), "Rocky.II");
  assert.equal(stripLangSuffix("Stephen.Kings.It"), "Stephen.Kings.It");
  assert.equal(stripLangSuffix("Show.PL"), "Show.PL");
  assert.equal(stripLangSuffix("Show.DE"), "Show.DE");
  assert.equal(stripLangSuffix("The.Office.UK"), "The.Office.UK");
  assert.equal(stripLangSuffix("Making.De-Luxe"), "Making.De-Luxe");
  // Lower-case codes, three-letter codes in any case and region forms are languages.
  assert.equal(stripLangSuffix("Movie.vi"), "Movie");
  assert.equal(stripLangSuffix("Movie.it"), "Movie");
  assert.equal(stripLangSuffix("Movie.ENG"), "Movie");
  assert.equal(stripLangSuffix("Movie.Eng"), "Movie");
  assert.equal(stripLangSuffix("Movie.ZH-TW"), "Movie");
  assert.equal(stripLangSuffix("Movie.English"), "Movie");
});

test("script and numeric region subtags and Bazarr's zt are read as languages", async () => {
  assert.equal(stripLangSuffix("Movie.zh-Hant"), "Movie");
  assert.equal(stripLangSuffix("Movie.zh-Hans"), "Movie");
  assert.equal(stripLangSuffix("Movie.es-419"), "Movie");
  assert.equal(stripLangSuffix("Movie.zh-Hant-TW"), "Movie");
  assert.equal(stripLangSuffix("Movie.zh-Hant-TW.forced"), "Movie");
  assert.equal(stripLangSuffix("Movie.zt"), "Movie");
  assert.equal(stripLangSuffix("Movie.xx-Hant"), "Movie.xx-Hant");

  // A Traditional task counts Bazarr's Movie.zt.srt as its output.
  useLanguages(["Traditional Chinese", "zh-TW"]);
  const dir = library("bazarr-zt", ["Movie.mkv", "Movie.en.srt", "Movie.zt.srt", "Clip.mkv", "Clip.zh-Hant-TW.srt"]);
  assert.deepEqual(await scan(dir), { "Clip.mkv": ["Clip.zh-Hant-TW.srt"], "Movie.mkv": ["Movie.en.srt"] });
  // Movie has its Chinese already; Clip's output drops the whole language tag.
  assert.deepEqual(jobsIn(dir), [["Clip.zh-Hant-TW.srt", "Clip.chi.srt"]]);
});

test("a queued Traditional job for .chi moves to .cht once Simplified is preferred, so it never writes Simplified's name", async (t) => {
  t.after(() => config.setSetting("preferred_chinese", "zh-TW"));
  config.setSetting("preferred_chinese", "zh-CN");
  const traditional = { target_lang: "Traditional Chinese", lang_code: "cht", output_pattern: "{{name}}.{{lang_code}}.srt", former_lang_codes: ["chi"] };
  assert.equal(standardOutputFor("/m/Show.en.srt", "/m/Show.chi.srt", traditional), "/m/Show.cht.srt");
});

test("a scan tells a translation already on disk from an output another subtitle owns", async () => {
  useLanguages(["Traditional Chinese", "zh-TW"]);
  const dir = library("exists-or-owned", ["Done.mkv", "Done.en.srt", "Done.chi.srt", "Pair.mkv", "Pair.srt", "Pair.en.srt"]);
  const tasksOf = async (name: string) =>
    (await scanFolder(false)).files.flatMap((file) => file.subtitles).find((s) => s.srtPath === path.join(dir, name))?.tasks.map((t) => [t.status, t.outputExists]);
  assert.deepEqual(await tasksOf("Done.en.srt"), [["skipped", true]]);
  // Pair.srt owns Pair.chi.srt, so Pair.en.srt is skipped with nothing on disk.
  assert.deepEqual(await tasksOf("Pair.en.srt"), [["skipped", false]]);
  assert.deepEqual(await tasksOf("Pair.srt"), [["new", false]]);
});
