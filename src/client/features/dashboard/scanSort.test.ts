import test from "node:test";
import assert from "node:assert/strict";
import type { ScannedFile } from "../../types.js";
import { latestFileMtime, scanFileKey, sortScanFiles, sortScanGroups, type ScanGroup } from "./scanSort.js";

function file(videoPath: string, videoName: string, videoMtime: number | null): ScannedFile {
  return { videoPath, videoName, videoMtime, subtitles: [] };
}

test("dashboard date sort orders files oldest-first and newest-first", () => {
  const files = [
    file("/media/new.mp4", "new.mp4", 300),
    file("/media/old.mp4", "old.mp4", 100),
    file("/media/mid.mp4", "mid.mp4", 200),
  ];
  assert.deepEqual(sortScanFiles(files, "date", "asc").map((item) => item.videoName), ["old.mp4", "mid.mp4", "new.mp4"]);
  assert.deepEqual(sortScanFiles(files, "date", "desc").map((item) => item.videoName), ["new.mp4", "mid.mp4", "old.mp4"]);
});

test("dashboard date sort keeps files without a date last", () => {
  const files = [
    file("/media/unknown.mp4", "unknown.mp4", null),
    file("/media/old.mp4", "old.mp4", 100),
  ];
  assert.deepEqual(sortScanFiles(files, "date", "desc").map((item) => item.videoName), ["old.mp4", "unknown.mp4"]);
});

test("dashboard sorting uses subtitle names for orphan entries", () => {
  const files: ScannedFile[] = [
    { videoPath: null, videoName: null, videoMtime: null, subtitles: [{ srtPath: "/media/zeta.srt", srtName: "zeta.srt", tasks: [] }] },
    { videoPath: null, videoName: null, videoMtime: null, subtitles: [{ srtPath: "/media/alpha.srt", srtName: "alpha.srt", tasks: [] }] },
  ];
  assert.deepEqual(sortScanFiles(files, "name", "asc").map((item) => item.subtitles[0]?.srtName), ["alpha.srt", "zeta.srt"]);
  assert.deepEqual(sortScanFiles(files, "name", "desc").map((item) => item.subtitles[0]?.srtName), ["zeta.srt", "alpha.srt"]);
  assert.notEqual(scanFileKey(files[0]), scanFileKey(files[1]));
});

test("folder date is the latest known descendant file date", () => {
  const files = [file("/media/show/episode.mp4", "episode.mp4", 250), file("/media/show/old.mp4", "old.mp4", 100)];
  assert.equal(latestFileMtime(files), 250);
  assert.equal(latestFileMtime([file("/media/unknown.mp4", "unknown.mp4", null)]), null);
});

test("dashboard date sort orders folders by their latest descendant file", () => {
  const groups: ScanGroup[] = [
    ["old-show", [file("/media/old-show/a.mp4", "a.mp4", 100)]],
    ["new-show", [file("/media/new-show/a.mp4", "a.mp4", 300)]],
  ];
  assert.deepEqual(sortScanGroups(groups, "date", "asc").map(([name]) => name), ["old-show", "new-show"]);
  assert.deepEqual(sortScanGroups(groups, "date", "desc").map(([name]) => name), ["new-show", "old-show"]);
});

test("dashboard name sort uses names for both folders and files", () => {
  const groups: ScanGroup[] = [
    ["zeta", [file("/media/zeta/z.mp4", "z.mp4", 1)]],
    ["alpha", [file("/media/alpha/a.mp4", "a.mp4", 2)]],
  ];
  assert.deepEqual(sortScanGroups(groups, "name", "asc").map(([name]) => name), ["alpha", "zeta"]);
});
