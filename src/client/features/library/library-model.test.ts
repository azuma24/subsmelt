import test from "node:test";
import assert from "node:assert/strict";
import type { Job, ScannedFile, TaskStatus } from "../../types";
import { makeJob, makeTaskStatus } from "../../test-fixtures";
import { relativeFolder, relevantJobId, toLibraryItems } from "./library-model";
import { languageStatusDisplay } from "./task-status";

const task = (langCode: string, status: TaskStatus["status"], jobId: number | null = null): TaskStatus =>
  makeTaskStatus({
    taskId: langCode === "chi" ? 1 : 2,
    targetLang: langCode === "chi" ? "Traditional Chinese" : "Japanese",
    langCode,
    status,
    jobId,
  });

const video = (path: string, tasks: TaskStatus[] | null): ScannedFile => ({
  videoPath: path,
  videoName: path.split("/").pop() ?? null,
  videoMtime: 1,
  subtitles: tasks === null ? [] : [{ srtPath: path.replace(/\.mkv$/, ".en.srt"), srtName: "x.en.srt", tasks }],
});

const job = (id: number, status: string): Job =>
  makeJob({ id, status, total_cues: 10, error: status === "error" ? "timeout" : null });

const jobs = new Map([
  [1, job(1, "error")],
  [2, job(2, "pending")],
  [3, job(3, "translating")],
  [4, job(4, "done")],
  [5, job(5, "done")],
]);

const files: ScannedFile[] = [
  video("/media/TV/Show/Season 01/Show.S01E02.mkv", [task("chi", "error", 1), task("jpn", "pending", 2)]),
  video("/media/TV/Show/Season 01/Show.S01E01.mkv", null),
  video("/media/TV/Show/Season 01/Show.S01E10.mkv", [task("chi", "new"), task("jpn", "translating", 3)]),
  video("/media/Movies/Arrival.mkv", [task("chi", "translating", 3)]),
  video("/media/Movies/Dune.mkv", [task("chi", "done", 4), task("jpn", "skipped")]),
  video("/media/Movies/Blade Runner.mkv", []),
  {
    videoPath: null,
    videoName: null,
    videoMtime: null,
    subtitles: [{ srtPath: "/media/Loose.srt", srtName: "Loose.srt", tasks: [task("chi", "done", 5)] }],
  },
  {
    videoPath: null,
    videoName: null,
    videoMtime: null,
    subtitles: [{ srtPath: "/media/Docs/Notes.srt", srtName: "Notes.srt", tasks: [] }],
  },
];

const items = toLibraryItems(files, "/media");
const byName = (name: string) => items.find((item) => item.name === name)!;

test("orphan subtitles keep their own kind and folder", () => {
  const loose = byName("Loose.srt");
  assert.equal(loose.kind, "subtitle");
  assert.equal(loose.folder, "");
  assert.equal(loose.key, "/media/Loose.srt");
});

test("folders are relative to the media root", () => {
  assert.equal(relativeFolder("/media/TV/Show/Season 01/a.mkv", "/media/"), "TV/Show/Season 01");
  assert.equal(relativeFolder("/media/a.mkv", "/media"), "");
  assert.equal(relativeFolder("/elsewhere/b.mkv", "/media"), "/elsewhere");
});

test("a language skipped because its file exists reads Already translated; one another subtitle owns stays Skipped", () => {
  const onDisk = { ...task("chi", "skipped"), outputExists: true };
  assert.deepEqual(languageStatusDisplay(onDisk, "skipped"), {
    labelKey: "library.panel.alreadyTranslated",
    icon: "done",
  });
  // The queue skips a job only when its output exists.
  assert.deepEqual(languageStatusDisplay(task("chi", "skipped", 7), "skipped"), {
    labelKey: "library.panel.alreadyTranslated",
    icon: "done",
  });
  const ownedElsewhere = { ...task("chi", "skipped"), outputExists: false };
  assert.deepEqual(languageStatusDisplay(ownedElsewhere, "skipped"), {
    labelKey: "dashboard.status.skipped",
    icon: "skipped",
  });
  assert.deepEqual(languageStatusDisplay(task("chi", "done", 7), "done"), {
    labelKey: "dashboard.status.done",
    icon: "done",
  });
});

test("a file's most relevant job is its error, then translating, then pending, else the newest", () => {
  const byPath = new Map(toLibraryItems(files, "/media").map((item) => [item.key, item]));
  const pick = (path: string) => {
    const item = byPath.get(path);
    assert.ok(item, path);
    return relevantJobId(item, jobs);
  };
  assert.equal(pick("/media/TV/Show/Season 01/Show.S01E02.mkv"), 1);
  assert.equal(pick("/media/TV/Show/Season 01/Show.S01E10.mkv"), 3);
  assert.equal(pick("/media/Movies/Dune.mkv"), 4);
  const [twoDone] = toLibraryItems(
    [video("/media/Twice.mkv", [task("chi", "done", 4), task("jpn", "done", 5)])],
    "/media",
  );
  assert.equal(relevantJobId(twoDone, jobs), 5);
  assert.equal(pick("/media/TV/Show/Season 01/Show.S01E01.mkv"), null);
  assert.equal(pick("/media/Docs/Notes.srt"), null);
});
