import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.ts and db.ts load from these folders at import, so set them first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-corrections-scan-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = path.join(root, "media");
fs.mkdirSync(process.env.CONFIG_DIR);
fs.writeFileSync(path.join(process.env.CONFIG_DIR, "config.json"), JSON.stringify({ settings: {} }));
const db = await import("./db.js");
const config = await import("./config.js");
const { scanForCorrections, applyCorrections } = await import("./corrections-scan.js");
import type { ScanResult } from "../shared/scan.js";
import type { CorrectionRule } from "../shared/corrections.js";

const media = process.env.MEDIA_DIR;
const write = (relative: string, text: string) => {
  const file = path.join(media, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const srt = (...lines: string[]) =>
  lines.map((line, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\n${line}\n`).join("\n");

const rule = (find: string, replace: string, extra: Partial<CorrectionRule> = {}): CorrectionRule => ({
  id: find,
  find,
  replace,
  stage: "source",
  match: "word",
  caseSensitive: true,
  languages: [],
  enabled: true,
  ...extra,
});

config.createTask({
  source_lang: "English",
  target_lang: "Traditional Chinese",
  output_pattern: "{{name}}.{{lang_code}}.srt",
  lang_code: "chi",
});
const task = config.getTasks().find((t) => t.lang_code === "chi")!;

const talk = write("AnKor/Talk.en.srt", srt("Welcome to Serenity", "Serenity again, and Serenity", "nothing"));
const talkChi = write("AnKor/Talk.chi.srt", srt("歡迎來到賽瑞尼", "又是賽瑞尼", "沒有"));
const verb = write("AnKor/Essay.en.srt", srt("the serenity of Wi-Fi"));
const movie = write("Movies/Film.en.srt", srt("Serenity in a movie"));
db.createJob({ task_id: task.id, srt_path: talk, output_path: talkChi, video_path: null, status: "done" });
const job = db.getJobBySrtAndTask(talk, task.id)!;
db.addJobUsage(job.id, 1000, 400);

function library(): ScanResult {
  const scanned = (srtPath: string, outputPath: string, exists: boolean, jobId: number | null) => ({
    srtPath,
    srtName: path.basename(srtPath),
    tasks: [
      {
        taskId: task.id,
        targetLang: task.target_lang,
        langCode: "chi",
        outputPath,
        outputName: path.basename(outputPath),
        status: (jobId ? "done" : "new") as "done" | "new",
        jobId,
        translatedTitle: null,
        outputExists: exists,
      },
    ],
  });
  return {
    complete: true,
    errors: [],
    files: [
      { videoPath: null, videoName: null, videoMtime: null, subtitles: [scanned(talk, talkChi, true, job.id)] },
      {
        videoPath: null,
        videoName: null,
        videoMtime: null,
        subtitles: [scanned(verb, `${verb}.chi.srt`, false, null)],
      },
      {
        videoPath: null,
        videoName: null,
        videoMtime: null,
        subtitles: [scanned(movie, `${movie}.chi.srt`, false, null)],
      },
    ],
    newJobs: 0,
    totalSubtitles: 3,
  };
}

test("a folder scan finds the sources a source rule changes, with counts, samples and their translations", () => {
  const report = scanForCorrections(library(), [rule("Serenity", "Sereniti")], { folders: ["AnKor"] });
  assert.equal(report.totalMatches, 3);
  assert.deepEqual(
    report.matches.map((m) => [m.relative, m.kind, m.count]),
    [["AnKor/Talk.en.srt", "source", 3]],
  );
  assert.deepEqual(report.matches[0].samples[0], { before: "Welcome to Serenity", after: "Welcome to Sereniti" });
  assert.deepEqual(report.matches[0].jobs, [{ id: job.id, langCode: "chi", tokens: 1400 }]);
  // Nothing outside the folder, and nothing written.
  assert.match(fs.readFileSync(talk, "utf8"), /Serenity/);
});

test("output rules look only at translations, filtered by language", () => {
  const out = rule("賽瑞尼", "Sereniti", { stage: "output", match: "phrase" });
  assert.deepEqual(
    scanForCorrections(library(), [out], { folders: [""] }).matches.map((m) => [m.relative, m.kind, m.count]),
    [["AnKor/Talk.chi.srt", "output", 2]],
  );
  assert.equal(scanForCorrections(library(), [{ ...out, languages: ["jpn"] }], { folders: [""] }).matches.length, 0);
});

test("a case-insensitive rule also finds the ordinary word, so the person can untick it", () => {
  const report = scanForCorrections(library(), [rule("serenity", "Sereniti", { caseSensitive: false })], {
    folders: ["AnKor"],
  });
  assert.deepEqual(
    report.matches.map((m) => m.relative),
    ["AnKor/Essay.en.srt", "AnKor/Talk.en.srt"],
  );
});

test("applying fixes only the ticked files and can queue their translations again", () => {
  const report = applyCorrections(library(), [rule("Serenity", "Sereniti")], [talk, "/etc/passwd"], true);
  assert.equal(report.totalFixed, 3);
  assert.equal(report.retranslated, 1);
  assert.deepEqual(report.results[1], { path: "/etc/passwd", total: 0, error: "not a subtitle in the library" });
  assert.match(fs.readFileSync(talk, "utf8"), /Welcome to Sereniti/);
  assert.match(fs.readFileSync(movie, "utf8"), /Serenity in a movie/);
  const requeued = db.getJob(job.id)!;
  assert.equal(requeued.status, "pending");
  assert.equal(requeued.force, 1);
});

test("an invalid rule is refused before anything is read", () => {
  assert.throws(
    () => scanForCorrections(library(), [rule("AnKor", "AnKor Network")], { folders: [""] }),
    /changed again/,
  );
  assert.throws(() => applyCorrections(library(), [], [talk], false), /No rules/);
});

test("a rule's exceptions keep a file out of the scan and the apply step", () => {
  const essayRule = rule("serenity", "Sereniti", { caseSensitive: false, except: ["AnKor/Essay.en.srt"] });
  const report = scanForCorrections(library(), [essayRule], { folders: ["AnKor"] });
  assert.ok(!report.matches.some((m) => m.relative === "AnKor/Essay.en.srt"));
  const applied = applyCorrections(library(), [essayRule], [verb], false);
  assert.equal(applied.totalFixed, 0);
  assert.match(fs.readFileSync(verb, "utf8"), /the serenity of Wi-Fi/);
});

test("preview and apply refuse incomplete library scans before touching files", () => {
  const partial = { ...library(), complete: false, errors: [{ path: "/media/missing", message: "permission denied" }] };
  const before = fs.readFileSync(talk, "utf8");
  const expected = /Library scan incomplete.*\/media\/missing: permission denied/;
  assert.throws(() => scanForCorrections(partial, [rule("Serenity", "changed")], { folders: [""] }), expected);
  assert.throws(() => applyCorrections(partial, [rule("Serenity", "changed")], [talk], true), expected);
  assert.equal(fs.readFileSync(talk, "utf8"), before);
});
