import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import type { ScannedFile } from "../../types";
import { makeTaskStatus } from "../../test-fixtures";
import { SubtitleLanguages } from "./PanelSections";

const file: ScannedFile = {
  videoPath: "/media/Movies/Arrival.mkv",
  videoName: "Arrival.mkv",
  videoMtime: 1,
  subtitles: [
    {
      srtPath: "/media/Movies/Arrival.en.srt",
      srtName: "Arrival.en.srt",
      tasks: [makeTaskStatus({ taskId: 1, targetLang: "Traditional Chinese", langCode: "chi", status: "done" })],
    },
  ],
};
// LibraryPanel passes a request number for the subtitle a row's "Translate to…" named.
const panel = (translateRequest: number) =>
  renderPage(
    <SubtitleLanguages
      subtitle={file.subtitles[0]}
      jobsById={new Map()}
      showName
      onPreview={() => {}}
      onQueued={() => {}}
      translateRequest={translateRequest}
    />,
    [[["tasks"], []]],
  );

test("a row's Translate to… opens the file's panel with the language form showing", () => {
  const page = panel(1);
  assert.ok(page.buttons.includes("Translate"), "the form's submit button is there");
  assert.ok(!page.buttons.includes("Translate to…"), "the form replaces its own opener");
});

test("opening the panel from the file name keeps the form closed", () => {
  const page = panel(0);
  assert.ok(page.buttons.includes("Translate to…"));
  assert.ok(!page.buttons.includes("Translate"));
});
