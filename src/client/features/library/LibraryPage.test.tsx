import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, SeededError, type QuerySeed } from "../../test-render";
import type { Job, ScannedFile, Task } from "../../types";
import { makeJob, makeTask, makeTaskStatus } from "../../test-fixtures";
import { LibraryPage } from "./LibraryPage";

const noJobs = [["jobs"], { jobs: [], queueRunning: false, currentJobId: null }] as const;
const settings = [["settings"], { _media_dir: "/media" }] as const;
const library = (files: ScannedFile[]) => [["library"], { files, newJobs: 0, totalSubtitles: 0 }] as const;

const episode: ScannedFile = {
  videoPath: "/media/TV/Severance/Season 02/Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.mkv",
  videoName: "Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.mkv",
  videoMtime: 1,
  subtitles: [
    {
      srtPath: "/media/TV/Severance/Season 02/Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.en.srt",
      srtName: "Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.en.srt",
      tasks: [
        makeTaskStatus({ taskId: 1, targetLang: "Traditional Chinese", langCode: "chi", status: "new" }),
        makeTaskStatus({ taskId: 2, targetLang: "Japanese", langCode: "jpn", status: "skipped" }),
      ],
    },
  ],
};

const render = (seed: QuerySeed) => renderPage(<LibraryPage />, seed);

test("while the library loads, the header's Scan stays available and no empty state flashes", () => {
  const page = render([noJobs, settings]);
  assert.equal(page.headings[0], "Library");
  assert.ok(page.buttons.includes("Scan"));
  assert.ok(!page.text.includes("No media found yet"));
  assert.match(page.html, /aria-hidden="true"/);
});

test("a failed scan preview says what failed and offers a retry", () => {
  const page = render([noJobs, settings, [["library"], new SeededError("MEDIA_DIR is not readable")]]);
  assert.ok(page.text.includes("The library could not be loaded: MEDIA_DIR is not readable"));
  assert.ok(page.buttons.includes("Retry"));
  assert.ok(!page.text.includes("No media found yet"));
});

test("an empty library explains itself and points at media sources", () => {
  const page = render([noJobs, settings, library([])]);
  assert.ok(page.headings.includes("No media found yet"));
  assert.ok(page.links.includes("Set up media sources"));
  assert.ok(!page.buttons.some((label) => label.startsWith("All")), "no status chips without media");
});

test("one file renders under its folder with its full name, status chips and counts", () => {
  const page = render([noJobs, settings, library([episode])]);
  assert.ok(page.text.includes("1 file"));
  for (const chip of [
    "All 1",
    "Errors 0",
    "Needs transcription 0",
    "Missing a language 1",
    "In progress 0",
    "Done 0",
  ]) {
    assert.ok(page.buttons.includes(chip), `missing chip ${chip}`);
  }
  assert.ok(page.text.includes("TV/Severance/Season 02"));
  assert.ok(page.text.includes("Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.mkv 1 subtitle chi jpn"));
  assert.match(page.html, /aria-label="New"[^>]*>.*?<\/svg>chi/);
  assert.match(page.html, /aria-label="Skipped"[^>]*>.*?<\/svg>jpn/);
  assert.equal(page.buttons.filter((label) => label === "Scan").length, 1);
  assert.ok(page.links.includes("Upload file"));
});

test("the Files view carries the same sort, select-all and refresh controls as the Transcribe picker", () => {
  const page = render([noJobs, settings, library([episode])]);
  assert.match(page.html, /aria-label="Sort files"/);
  assert.match(page.html, /<option[^>]*value="name"[^>]*>Name<\/option>/);
  assert.match(page.html, /<option[^>]*value="date"[^>]*>Date<\/option>/);
  assert.ok(page.buttons.includes("Select all"));
  assert.ok(page.buttons.some((label) => label === "Refresh"));
  assert.ok(page.text.includes("Descending"), "direction toggle defaults to descending");
});

function job(id: number, name: string, status: string): Job {
  return makeJob({
    id,
    srt_path: `/media/Show/${name}`,
    output_path: `/media/Show/${name.replace(".en.srt", ".zh-TW.srt")}`,
    status,
    total_cues: 100,
    completed_cues: status === "done" ? 100 : 0,
    error: status === "error" ? "boom" : null,
    target_lang: "Traditional Chinese",
    lang_code: "zh-TW",
  });
}

const zhTask: Task = makeTask({
  id: 1,
  source_lang: "English",
  target_lang: "Traditional Chinese",
  output_pattern: "",
  lang_code: "zh-TW",
});

const configured: QuerySeed = [
  [
    ["jobs"],
    {
      jobs: [
        job(1, "Episode 01.en.srt", "done"),
        job(2, "Episode 02.en.srt", "error"),
        job(3, "Episode 03.en.srt", "pending"),
      ],
      queueRunning: false,
      currentJobId: null,
    },
  ],
  [["tasks"], [zhTask]],
  [["settings"], { _llm_configured: true, _media_dir: "/media" }],
  library([episode]),
];

const selectedTab = (page: { html: string }) =>
  page.html
    .match(/role="tab" aria-selected="true"[^>]*>(.*?)<\/button>/)?.[1]
    .replace(/<[^>]+>/g, " ")
    .trim();

test("the home page opens on the Files view with Jobs one tab away", () => {
  const page = renderPage(<LibraryPage />, configured);
  assert.equal(selectedTab(page), "Files");
  assert.ok(page.buttons.includes("Jobs 3"));
  assert.ok(!page.buttons.includes("Transcriptions"), "no Transcriptions view while transcription is off");
  assert.ok(page.text.includes("Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.mkv"));
  assert.ok(!page.text.includes("Episode 02.en.srt"));
});

test("a fresh install shows the setup checklist, and its Jobs view says the queue is empty", () => {
  const fresh: QuerySeed = [noJobs, [["tasks"], []], [["settings"], {}]];
  const files = renderPage(<LibraryPage />, fresh);
  assert.ok(files.text.includes("Setup checklist 0 of 4 done Dismiss"));
  assert.ok(files.text.includes("LLM connection Configure endpoint and model."));
  assert.ok(files.text.includes("Translation targets Add at least one enabled translation target."));
  assert.ok(files.text.includes("Media discovered Run scan to discover subtitle files. Scan now"));

  const jobs = renderPage(<LibraryPage />, fresh, { path: "/?view=jobs" });
  assert.ok(jobs.text.includes("No jobs matching filter"));
  assert.ok(jobs.buttons.includes("All 0"));
});

test("?view=jobs lists every seeded job with its status filters and bulk actions", () => {
  const page = renderPage(<LibraryPage />, configured, { path: "/?view=jobs" });
  assert.equal(selectedTab(page), "Jobs 3");
  assert.ok(page.text.includes("Episode 01.en.srt Traditional Chinese · zh-TW Done 100/100 cues"));
  assert.ok(page.text.includes("Episode 02.en.srt Traditional Chinese · zh-TW Error"));
  assert.ok(page.text.includes("Episode 03.en.srt Traditional Chinese · zh-TW Pending"));
  assert.ok(!page.text.includes("No jobs matching filter"));
  for (const label of ["All 3", "Pending 1", "Done 1", "Errors 1", "Retry visible errors (1)", "Clear finished"]) {
    assert.ok(page.buttons.includes(label), `missing button ${label}`);
  }
  assert.ok(!page.text.includes("Tokens"), "token usage lives in Settings > Usage");
});

test("?view=jobs&status=error shows only the failed job", () => {
  const page = renderPage(<LibraryPage />, configured, { path: "/?view=jobs&status=error" });
  assert.ok(page.text.includes("Episode 02.en.srt"));
  assert.ok(!page.text.includes("Episode 01.en.srt"));
  assert.ok(!page.text.includes("Episode 03.en.srt"));
  assert.match(page.html, /aria-pressed="true"[^>]*>Errors/);
});

test("the queue band offers Run all while jobs wait, and is absent when nothing is queued", () => {
  const waiting = renderPage(<LibraryPage />, configured);
  assert.ok(waiting.text.includes("Queue idle 1 more in queue ▶ Run All"));

  const translating = { ...job(4, "Episode 04.en.srt", "translating"), completed_cues: 40 };
  const running = renderPage(<LibraryPage />, [
    [
      ["jobs"],
      {
        jobs: [translating, job(5, "Episode 05.en.srt", "translating"), job(3, "Episode 03.en.srt", "pending")],
        queueRunning: true,
        currentJobId: 4,
      },
    ],
    settings,
    library([episode]),
  ]);
  assert.ok(running.text.includes("Episode 04.en.srt → zh-TW +1 40% 1 more in queue ⏹ Stop"));
  assert.ok(!running.text.includes("Episode 05.en.srt"), "only the first translating job is named");
  assert.ok(waiting.buttons.includes("▶ Run All"));

  const idle = renderPage(<LibraryPage />, [noJobs, settings, library([episode])]);
  assert.ok(!idle.text.includes("Queue idle"));
  assert.ok(!idle.buttons.includes("▶ Run All"));
});

test("the Jobs view shows a loading skeleton, not the empty hint, before the first jobs response", () => {
  const seed: QuerySeed = [
    [["tasks"], [zhTask]],
    [["settings"], { _llm_configured: true }],
  ];
  for (const isMobile of [false, true]) {
    const page = renderPage(<LibraryPage />, seed, { isMobile, path: "/?view=jobs" });
    assert.ok(page.text.includes("Loading…"));
    assert.ok(!page.text.includes("No jobs matching filter"));
    assert.match(page.html, /aria-busy="true"/);
  }
});

test("a failed jobs request in the Jobs view says what failed with a retry, not the empty hint", () => {
  const page = renderPage(
    <LibraryPage />,
    [
      [["jobs"], new SeededError("database is locked")],
      [["tasks"], [zhTask]],
      [["settings"], { _llm_configured: true }],
    ],
    { path: "/?view=jobs" },
  );
  assert.ok(page.text.includes("Could not load the job queue: database is locked"));
  assert.ok(page.buttons.includes("Retry"));
  assert.ok(!page.text.includes("No jobs matching filter"));
  assert.ok(!page.text.includes("Loading…"));
});

test("the phone header carries the LLM status beside Scan", () => {
  const llmStatus = {
    mode: "fallback",
    connections: [
      { id: "desk", label: "Desk GPU", model: "qwen", host: "10.0.0.5:1234", state: "in_use", jobIds: [4] },
      { id: "spare", label: "Spare box", model: "gemma", host: "10.0.0.6:1234", state: "offline", jobIds: [] },
    ],
  };
  const page = renderPage(<LibraryPage />, [...configured, [["llm-status"], llmStatus]], { isMobile: true });
  assert.equal(page.buttons[0], "Translating on Desk GPU 1 offline");
  assert.ok(page.buttons.includes("Scan"));
  assert.ok(page.buttons.includes("▶ Run All"));
});

test("the setup checklist lists only the steps left, with progress beside its title", () => {
  const page = renderPage(<LibraryPage />, configured);
  assert.ok(page.text.includes("Setup checklist 3 of 4 done Dismiss Queue status Queue is idle. Run queue"));
  for (const finished of ["LLM connection", "Translation targets", "Media discovered"]) {
    assert.ok(!page.text.includes(finished), `${finished} is done and hidden`);
  }
});
