import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, SeededError, type QuerySeed } from "../../test-render";
import type { ScannedFile } from "../../types";
import { makeTaskStatus } from "../../test-fixtures";
import { LibraryPage } from "./LibraryPage";

const noJobs = [["jobs"], { jobs: [], queueRunning: false, currentJobId: null }] as const;
const settings = [["settings"], { _media_dir: "/media" }] as const;
const library = (files: ScannedFile[]) => [["library"], { files, newJobs: 0, totalSubtitles: 0 }] as const;

const episode: ScannedFile = {
  videoPath: "/media/TV/Severance/Season 02/Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.mkv",
  videoName: "Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.mkv",
  videoMtime: 1,
  subtitles: [{
    srtPath: "/media/TV/Severance/Season 02/Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.en.srt",
    srtName: "Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.en.srt",
    tasks: [
      makeTaskStatus({ taskId: 1, targetLang: "Traditional Chinese", langCode: "chi", status: "new" }),
      makeTaskStatus({ taskId: 2, targetLang: "Japanese", langCode: "jpn", status: "skipped" }),
    ],
  }],
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
  for (const chip of ["All 1", "Errors 0", "Needs transcription 0", "Missing a language 1", "In progress 0", "Done 0"]) {
    assert.ok(page.buttons.includes(chip), `missing chip ${chip}`);
  }
  assert.ok(page.text.includes("TV/Severance/Season 02"));
  assert.ok(page.text.includes("Severance.S02E08.Sweet.Vitriol.1080p.ATVP.WEB-DL.mkv 1 subtitle chi jpn"));
  assert.match(page.html, /aria-label="New"[^>]*>.*?<\/svg>chi/);
  assert.match(page.html, /aria-label="Skipped"[^>]*>.*?<\/svg>jpn/);
  assert.equal(page.buttons.filter((label) => label === "Scan").length, 1);
  assert.ok(page.links.includes("Upload file"));
});

test("the header carries the same sort, select-all and refresh controls as the Transcribe picker", () => {
  const page = render([noJobs, settings, library([episode])]);
  assert.match(page.html, /aria-label="Sort files"/);
  assert.match(page.html, /<option[^>]*value="name"[^>]*>Name<\/option>/);
  assert.match(page.html, /<option[^>]*value="date"[^>]*>Date<\/option>/);
  assert.ok(page.buttons.includes("Select all"));
  assert.ok(page.buttons.some((label) => label === "Refresh"));
  assert.ok(page.text.includes("Descending"), "direction toggle defaults to descending");
});
