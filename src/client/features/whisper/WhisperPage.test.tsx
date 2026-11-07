import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, type QuerySeed } from "../../test-render";
import { WhisperPage } from "./WhisperPage";

const emptyHistory: QuerySeed[number] = [["transcription-history", 20], { attempts: [] }];

test("with speech-to-text off the page explains why and links to Settings", () => {
  const page = renderPage(<WhisperPage />, [[["settings"], {}], emptyHistory]);

  assert.equal(page.headings[0], "Transcribe");
  assert.ok(page.text.includes("Speech-to-text is disabled."));
  assert.ok(page.links.includes("Open Settings"));
  assert.ok(page.text.includes("No transcription attempts yet."));
  assert.ok(!page.headings.includes("Transcribe library files"));
});

test("enabled without a backend URL warns instead of hiding the picker silently", () => {
  const page = renderPage(<WhisperPage />, [[["settings"], { transcription_enabled: "1" }], emptyHistory]);

  assert.ok(page.text.includes("Speech-to-text is on, but no backend URL is set."));
  assert.ok(page.links.includes("Open Settings"));
  assert.ok(!page.headings.includes("Run options"));
});

test("a configured backend shows run options and the library grouped by folder", () => {
  const page = renderPage(<WhisperPage />, [
    [
      ["settings"],
      { transcription_enabled: "1", transcription_backend_url: "http://whisper:8000", _media_dir: "/media" },
    ],
    [["whisper-models"], { models: [{ id: "small", downloaded: true }] }],
    [
      ["library"],
      {
        files: [
          {
            videoPath: "/media/Movies/Arrival (2016).mkv",
            videoName: "Arrival (2016).mkv",
            videoMtime: 1,
            subtitles: [],
          },
          { videoPath: "/media/Movies/Dune.mkv", videoName: "Dune.mkv", videoMtime: 2, subtitles: [] },
        ],
        newJobs: 0,
        totalSubtitles: 0,
      },
    ],
    emptyHistory,
  ]);

  assert.deepEqual(page.headings, [
    "Transcribe",
    "Run options",
    "When subtitles are missing",
    "Transcribe library files",
    "Recent transcriptions",
  ]);
  assert.ok(page.text.includes("Auto-transcribe"));
  assert.ok(page.buttons.includes("Movies ( 2 )"));
  assert.ok(page.buttons.includes("Select all"));
  assert.ok(!page.text.includes("Speech-to-text is disabled."));
});

test("the header links to pending reviews even with speech-to-text disabled", () => {
  const page = renderPage(
    <WhisperPage />,
    [
      [["settings"], { transcription_enabled: "0" }],
      emptyHistory,
      [
        ["transcription-work"],
        {
          items: [
            { id: "source-1", kind: "file", input: "/media/Arrival.mkv", status: "needs_review" },
            { id: "source-2", kind: "file", input: "/media/Dune.mkv", status: "needs_review" },
            { id: "old", kind: "file", input: "/media/Old.mkv", status: "succeeded" },
          ],
        },
      ],
    ],
    { path: "/whisper" },
  );
  assert.ok(page.links.includes("Needs review 2"));
  assert.match(page.html, /href="\/whisper#transcription-reviews"/);
  assert.match(page.html, /id="transcription-reviews"/);
  assert.match(page.html, /id="transcription-review-source-2"/);
});

test("an active batch can be cancelled on opening Transcribe without any selection", () => {
  const page = renderPage(<WhisperPage />, [
    [["settings"], { transcription_enabled: "1", transcription_backend_url: "http://whisper:8000" }],
    [["library"], { files: [], newJobs: 0, totalSubtitles: 0 }],
    [
      ["transcription-work"],
      {
        items: [
          { id: "done", kind: "file", status: "succeeded", batchId: "existing", input: "/media/Done.mkv" },
          { id: "next", kind: "file", status: "queued", batchId: "existing", input: "/media/Next.mkv" },
        ],
      },
    ],
    emptyHistory,
  ]);

  assert.ok(page.buttons.includes("Cancel"));
  assert.match(page.text, /Transcribing 1\/2…/);
  assert.doesNotMatch(page.text, /0 selected/);
});
