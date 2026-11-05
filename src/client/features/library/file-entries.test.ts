import test from "node:test";
import assert from "node:assert/strict";
import type { Job, ScannedFile, TaskStatus } from "../../types";
import { makeJob, makeTaskStatus } from "../../test-fixtures";
import { fileEntries, fileFilterOptions, fileMatchesFilters, fileMatchesStatus } from "./file-entries";
import { toLibraryItems } from "./library-model";

const task = (langCode: string, status: TaskStatus["status"], jobId: number | null = null): TaskStatus =>
  makeTaskStatus({ taskId: langCode === "chi" ? 1 : 2, targetLang: langCode, langCode, status, jobId });

const files: ScannedFile[] = [
  { videoPath: "/media/Movies/Bare.mkv", videoName: "Bare.mkv", videoMtime: 1, subtitles: [] },
  {
    videoPath: "/media/Shows/Ep1.mkv",
    videoName: "Ep1.mkv",
    videoMtime: 1,
    subtitles: [
      {
        srtPath: "/media/Shows/Ep1.en.srt",
        srtName: "Ep1.en.srt",
        tasks: [task("chi", "done", 1), task("jpn", "new")],
      },
      // A second source names the same languages; the chip shows the most pressing state.
      { srtPath: "/media/Shows/Ep1.fr.srt", srtName: "Ep1.fr.srt", tasks: [task("chi", "pending", 2)] },
    ],
  },
];
const jobs = new Map<number, Job>([
  [1, makeJob({ id: 1, status: "done" })],
  [2, makeJob({ id: 2, status: "error" })],
]);
const [bare, episode] = fileEntries(toLibraryItems(files, "/media"), jobs);

test("a file shows one chip per language, its most pressing state across sources", () => {
  assert.deepEqual(
    episode.chips.map(({ task: t, status }) => [t.langCode, status]),
    [
      ["chi", "error"],
      ["jpn", "new"],
    ],
  );
});

test("status filters pick the files with that kind of work", () => {
  assert.equal(fileMatchesStatus(bare, "needsTranscription"), true);
  assert.equal(fileMatchesStatus(episode, "needsTranscription"), false);
  assert.equal(fileMatchesStatus(episode, "notQueued"), true);
  assert.equal(fileMatchesStatus(episode, "error"), true);
  assert.equal(fileMatchesStatus(episode, "done"), false, "chi's most pressing state is the error");
  assert.equal(fileMatchesStatus(bare, "all"), true);
});

test("a language found already translated on disk counts as Done", () => {
  const [onDisk] = fileEntries(
    toLibraryItems(
      [
        {
          ...files[1],
          subtitles: [{ ...files[1].subtitles[0], tasks: [{ ...task("chi", "skipped"), outputExists: true }] }],
        },
      ],
      "/media",
    ),
    new Map(),
  );
  assert.equal(fileMatchesStatus(onDisk, "done"), true);
});

test("the dropdowns offer every file's folder and languages", () => {
  assert.deepEqual(fileFilterOptions([bare, episode], "Media root"), {
    folders: ["Movies", "Shows"],
    targets: ["chi (chi)", "jpn (jpn)"],
  });
});

test("search, folder and language filters apply to files", () => {
  assert.equal(fileMatchesFilters(episode, "ep1", "all", "all", "Media root"), true);
  assert.equal(fileMatchesFilters(episode, "", "Movies", "all", "Media root"), false);
  assert.equal(fileMatchesFilters(episode, "", "all", "jpn (jpn)", "Media root"), true);
  assert.equal(fileMatchesFilters(bare, "", "all", "jpn (jpn)", "Media root"), false);
});

test("global sorting covers all directions, stable ties, absent dates and filtered entries without mutation", async () => {
  const { sortFileEntries } = await import("./file-entries");
  const source: ScannedFile[] = [
    { videoPath: "/media/Z/B.mkv", videoName: "B.mkv", videoMtime: 10, subtitles: [] },
    { videoPath: "/media/A/A.mkv", videoName: "A.mkv", videoMtime: 20, subtitles: [] },
    { videoPath: "/media/Z/A.mkv", videoName: "A.mkv", videoMtime: 20, subtitles: [] },
    {
      videoPath: null,
      videoName: null,
      videoMtime: null,
      subtitleMtime: 5,
      subtitles: [{ srtPath: "/media/A/C.srt", srtName: "C.srt", tasks: [] }],
    },
    {
      videoPath: null,
      videoName: null,
      videoMtime: null,
      subtitles: [{ srtPath: "/media/A/D.srt", srtName: "D.srt", tasks: [] }],
    },
  ];
  const entries = fileEntries(toLibraryItems(source, "/media"), new Map());
  const keys = (sorted: typeof entries) => sorted.map((entry) => entry.item.key);
  const a = "/media/A/A.mkv",
    az = "/media/Z/A.mkv",
    b = "/media/Z/B.mkv",
    c = "/media/A/C.srt",
    d = "/media/A/D.srt";
  assert.deepEqual(keys(sortFileEntries(entries, "name-asc")), [a, az, b, c, d]);
  assert.deepEqual(keys(sortFileEntries(entries, "name-desc")), [d, c, b, a, az]);
  assert.deepEqual(keys(sortFileEntries(entries, "date-desc")), [a, az, b, c, d]);
  assert.deepEqual(keys(sortFileEntries(entries, "date-asc")), [c, b, a, az, d]);
  const filtered = entries.filter((entry) => fileMatchesFilters(entry, "", "A", "all", "Root"));
  assert.deepEqual(keys(sortFileEntries(filtered, "date-asc")), [c, a, d]);
  assert.deepEqual(keys(entries), [b, a, az, c, d]);
});
