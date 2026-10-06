import test from "node:test";
import assert from "node:assert/strict";
import type { JobRow, ScannedFile, TaskStatus } from "../../types";
import { buildLibraryView, flattenRows, itemLanguageChips, itemStatus, relativeFolder, toLibraryItems, type LibraryRow } from "./library-model";
import { languageStatusDisplay } from "./task-status";

const task = (langCode: string, status: string, jobId: number | null = null): TaskStatus => ({
  taskId: langCode === "chi" ? 1 : 2,
  targetLang: langCode === "chi" ? "Traditional Chinese" : "Japanese",
  langCode,
  outputName: "",
  status,
  jobId,
});

const video = (path: string, tasks: TaskStatus[] | null): ScannedFile => ({
  videoPath: path,
  videoName: path.split("/").pop() ?? null,
  videoMtime: 1,
  subtitles: tasks === null ? [] : [{ srtPath: path.replace(/\.mkv$/, ".en.srt"), srtName: "x.en.srt", tasks }],
});

const job = (id: number, status: string): JobRow => ({
  id,
  srt_path: "",
  output_path: "",
  status,
  priority: 0,
  total_cues: 10,
  completed_cues: 0,
  error: status === "error" ? "timeout" : null,
  duration_seconds: null,
  target_lang: "",
  lang_code: "",
  force: 0,
});

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
  { videoPath: null, videoName: null, videoMtime: null, subtitles: [{ srtPath: "/media/Loose.srt", srtName: "Loose.srt", tasks: [task("chi", "done", 5)] }] },
  { videoPath: null, videoName: null, videoMtime: null, subtitles: [{ srtPath: "/media/Docs/Notes.srt", srtName: "Notes.srt", tasks: [] }] },
];

const items = toLibraryItems(files, "/media");
const byName = (name: string) => items.find((item) => item.name === name)!;

test("each item gets exactly one status, by precedence", () => {
  assert.equal(itemStatus(byName("Show.S01E02.mkv"), jobs), "error");
  assert.equal(itemStatus(byName("Show.S01E01.mkv"), jobs), "needsTranscription");
  assert.equal(itemStatus(byName("Show.S01E10.mkv"), jobs), "missingLanguage");
  assert.equal(itemStatus(byName("Arrival.mkv"), jobs), "inProgress");
  assert.equal(itemStatus(byName("Dune.mkv"), jobs), "done");
  assert.equal(itemStatus(byName("Loose.srt"), jobs), "done");
});

test("a subtitle no translation target applies to is neither needs-transcription nor missing: it reads as done", () => {
  assert.equal(itemStatus(byName("Blade Runner.mkv"), jobs), "done");
  assert.equal(itemStatus(byName("Notes.srt"), jobs), "done");
});

test("a job that has since finished overrides the scan's stale status", () => {
  const live = new Map([[1, job(1, "done")], [2, job(2, "done")]]);
  assert.equal(itemStatus(byName("Show.S01E02.mkv"), live), "done");
});

test("a task whose job was cleared reads as missing, not in progress", () => {
  assert.equal(itemStatus(byName("Arrival.mkv"), new Map()), "missingLanguage");
});

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

const rowLabels = (rows: LibraryRow[]) =>
  rows.map((row) => (row.type === "section" ? `# ${row.section.key}` : row.entry.item.name));

test("All groups by folder in natural order", () => {
  const view = buildLibraryView(items, jobs, "all", "");
  assert.deepEqual(rowLabels(flattenRows(view.sections, new Set())), [
    "# ",
    "Loose.srt",
    "# Docs",
    "Notes.srt",
    "# Movies",
    "Arrival.mkv",
    "Blade Runner.mkv",
    "Dune.mkv",
    "# TV/Show/Season 01",
    "Show.S01E01.mkv",
    "Show.S01E02.mkv",
    "Show.S01E10.mkv",
  ]);
});

test("a collapsed folder keeps its header and hides its rows", () => {
  const view = buildLibraryView(items, jobs, "all", "");
  assert.deepEqual(rowLabels(flattenRows(view.sections, new Set(["Movies", "TV/Show/Season 01"]))), [
    "# ",
    "Loose.srt",
    "# Docs",
    "Notes.srt",
    "# Movies",
    "# TV/Show/Season 01",
  ]);
});

test("a status filter flattens into one status group across folders", () => {
  const view = buildLibraryView(items, jobs, "done", "");
  assert.deepEqual(rowLabels(flattenRows(view.sections, new Set(["Movies"]))), ["# done", "Loose.srt", "Notes.srt", "Blade Runner.mkv", "Dune.mkv"]);
});

test("counts cover the searched set and always equal each filter's list length", () => {
  for (const query of ["", "show", "dune", "nothing-matches"]) {
    const all = buildLibraryView(items, jobs, "all", query);
    for (const filter of ["all", "error", "needsTranscription", "missingLanguage", "inProgress", "done"] as const) {
      const listed = flattenRows(buildLibraryView(items, jobs, filter, query).sections, new Set()).filter((row) => row.type === "item").length;
      assert.equal(all.counts[filter], listed, `${filter} with query "${query}"`);
    }
  }
  assert.deepEqual(buildLibraryView(items, jobs, "all", "").counts, {
    all: 8, error: 1, needsTranscription: 1, missingLanguage: 1, inProgress: 1, done: 4,
  });
});

test("search matches the folder path as well as the name", () => {
  const view = buildLibraryView(items, jobs, "all", "season 01");
  assert.equal(view.counts.all, 3);
});

test("a video shows one chip per language, whatever number of source subtitles it has", () => {
  // Three source subtitles all translate into the same Chinese file: one owns it, the others are skipped.
  const file: ScannedFile = {
    videoPath: "/media/talk.mkv",
    videoName: "talk.mkv",
    videoMtime: 1,
    subtitles: [
      { srtPath: "/media/talk.eng.srt", srtName: "talk.eng.srt", tasks: [task("chi", "skipped")] },
      { srtPath: "/media/talk.ko.srt", srtName: "talk.ko.srt", tasks: [task("chi", "new"), task("jpn", "done")] },
      { srtPath: "/media/talk.fr.srt", srtName: "talk.fr.srt", tasks: [task("chi", "skipped"), task("jpn", "skipped")] },
    ],
  };
  const [item] = toLibraryItems([file], "/media");
  assert.deepEqual(
    itemLanguageChips(item, new Map()).map(({ task: t, status }) => `${t.langCode}:${status}`),
    ["chi:new", "jpn:done"],
  );
  // A running job wins over every other state of that language.
  const running = { ...file, subtitles: [{ ...file.subtitles[0], tasks: [task("chi", "pending", 7)] }, file.subtitles[1]] };
  const [runningItem] = toLibraryItems([running], "/media");
  assert.deepEqual(
    itemLanguageChips(runningItem, new Map([[7, job(7, "translating")]])).map(({ task: t, status }) => `${t.langCode}:${status}`),
    ["chi:translating", "jpn:done"],
  );
});

test("a language skipped because its file exists reads Already translated; one another subtitle owns stays Skipped", () => {
  const onDisk = { ...task("chi", "skipped"), outputExists: true };
  assert.deepEqual(languageStatusDisplay(onDisk, "skipped"), { labelKey: "library.panel.alreadyTranslated", icon: "done" });
  // The queue skips a job only when its output exists.
  assert.deepEqual(languageStatusDisplay(task("chi", "skipped", 7), "skipped"), { labelKey: "library.panel.alreadyTranslated", icon: "done" });
  const ownedElsewhere = { ...task("chi", "skipped"), outputExists: false };
  assert.deepEqual(languageStatusDisplay(ownedElsewhere, "skipped"), { labelKey: "dashboard.status.skipped", icon: "skipped" });
  assert.deepEqual(languageStatusDisplay(task("chi", "done", 7), "done"), { labelKey: "dashboard.status.done", icon: "done" });
});

test("a row's status group comes from the same per-language state as its chips", () => {
  // One sibling's translation was queued by hand; the other sibling still reads "new".
  const file: ScannedFile = {
    videoPath: "/media/talk.mkv",
    videoName: "talk.mkv",
    videoMtime: 1,
    subtitles: [
      { srtPath: "/media/talk.ko.srt", srtName: "talk.ko.srt", tasks: [task("chi", "pending", 9)] },
      { srtPath: "/media/talk.fr.srt", srtName: "talk.fr.srt", tasks: [task("chi", "new")] },
    ],
  };
  const [item] = toLibraryItems([file], "/media");
  const jobsById = new Map([[9, job(9, "pending")]]);
  assert.deepEqual(itemLanguageChips(item, jobsById).map(({ status }) => status), ["pending"]);
  assert.equal(itemStatus(item, jobsById), "inProgress");
});
