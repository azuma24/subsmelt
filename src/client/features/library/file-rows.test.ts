import test from "node:test";
import assert from "node:assert/strict";
import type { Job, ScannedFile, TaskStatus } from "../../types";
import { makeJob, makeTaskStatus } from "../../test-fixtures";
import { toLibraryItems } from "./library-model";
import { fileRowMatches, fileRows, fileRowTarget } from "./file-rows";

const MEDIA = "/media";
const task = (langCode: string, status: TaskStatus["status"], jobId: number | null = null): TaskStatus =>
  makeTaskStatus({ taskId: langCode === "chi" ? 1 : 2, targetLang: langCode, langCode, status, jobId });

const files: ScannedFile[] = [
  { videoPath: "/media/Movies/Perfect.Days.mkv", videoName: "Perfect.Days.mkv", videoMtime: 3, subtitles: [] },
  {
    videoPath: "/media/Movies/Arrival.mkv",
    videoName: "Arrival.mkv",
    videoMtime: 2,
    subtitles: [
      {
        srtPath: "/media/Movies/Arrival.en.srt",
        srtName: "Arrival.en.srt",
        tasks: [task("chi", "new"), task("jpn", "pending", 7)],
      },
    ],
  },
  {
    videoPath: "/media/Shows/Expanse.S01E01.mkv",
    videoName: "Expanse.S01E01.mkv",
    videoMtime: 1,
    subtitles: [
      {
        srtPath: "/media/Shows/Expanse.S01E01.en.srt",
        srtName: "Expanse.S01E01.en.srt",
        tasks: [task("chi", "done", 8)],
      },
    ],
  },
];
const jobs = new Map<number, Job>([
  [7, makeJob({ id: 7, status: "pending" })],
  [8, makeJob({ id: 8, status: "done" })],
]);

test("a video without subtitles and an untranslated language become rows; anything with a job does not", () => {
  const rows = fileRows(toLibraryItems(files, MEDIA), jobs);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.name, row.kind === "unqueued" ? row.task.langCode : null]),
    [
      ["untranscribed", "Perfect.Days.mkv", null],
      ["unqueued", "Arrival.en.srt", "chi"],
    ],
  );
});

test("a language whose job was cleared counts as not queued again", () => {
  const cleared = [{ ...files[2], subtitles: [{ ...files[2].subtitles[0], tasks: [task("chi", "pending", 99)] }] }];
  const rows = fileRows(toLibraryItems(cleared, MEDIA), jobs);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["unqueued"],
  );
});

test("a not-queued row names its target the way the target filter lists jobs", () => {
  const [untranscribed, unqueued] = fileRows(toLibraryItems(files, MEDIA), jobs);
  assert.equal(fileRowTarget(untranscribed), null);
  assert.equal(fileRowTarget(unqueued), "chi (chi)");
});

test("search and folder filters match the file's name and folder", () => {
  const [untranscribed, unqueued] = fileRows(toLibraryItems(files, MEDIA), jobs);
  assert.equal(fileRowMatches(untranscribed, "perfect", ""), true);
  assert.equal(fileRowMatches(untranscribed, "arrival", ""), false);
  assert.equal(fileRowMatches(unqueued, "", "Movies"), true);
  assert.equal(fileRowMatches(unqueued, "", "Shows"), false);
});
