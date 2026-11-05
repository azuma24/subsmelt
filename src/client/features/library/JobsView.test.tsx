import test from "node:test";
import assert from "node:assert/strict";
import { makeJob, makeTaskStatus } from "../../test-fixtures";
import { fileEntries } from "./file-entries";
import { toLibraryItems } from "./library-model";
import { visibleFileEntries } from "./JobsView";

test("selected status and target are suspended on jobs failure and restored on recovery", () => {
  const entries = fileEntries(
    toLibraryItems(
      [
        { videoPath: "/media/Shows/Bare.mkv", videoName: "Bare.mkv", videoMtime: 1, subtitles: [] },
        {
          videoPath: "/media/Shows/Matched.mkv",
          videoName: "Matched.mkv",
          videoMtime: 1,
          subtitles: [
            {
              srtPath: "/media/Shows/Matched.en.srt",
              srtName: "Matched.en.srt",
              tasks: [
                makeTaskStatus({ taskId: 1, targetLang: "Japanese", langCode: "jpn", status: "error", jobId: 1 }),
              ],
            },
          ],
        },
        { videoPath: "/media/Other/Outside.mkv", videoName: "Outside.mkv", videoMtime: 1, subtitles: [] },
      ],
      "/media",
    ),
    new Map([[1, makeJob({ id: 1, status: "error" })]]),
  );
  const names = (unavailable: boolean, query = "", folder = "all") =>
    visibleFileEntries(entries, "error", "Japanese (jpn)", query, folder, "Media root", "name-asc", unavailable).map(
      (entry) => entry.item.name,
    );

  assert.deepEqual(names(false), ["Matched.mkv"]);
  assert.deepEqual(names(true), ["Bare.mkv", "Matched.mkv", "Outside.mkv"]);
  assert.deepEqual(names(true, "bare"), ["Bare.mkv"], "search remains active");
  assert.deepEqual(names(true, "", "Shows"), ["Bare.mkv", "Matched.mkv"], "folder remains active");
  assert.deepEqual(names(false), ["Matched.mkv"], "selections apply again after recovery");
});
