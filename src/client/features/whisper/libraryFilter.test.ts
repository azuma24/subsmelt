import test from "node:test";
import assert from "node:assert/strict";
import { filterLibraryFiles, hasSubtitles } from "./libraryFilter.js";
import type { ScannedFile } from "../../types";

function file(videoPath: string, subtitleCount = 0): ScannedFile {
  return {
    videoPath,
    videoName: videoPath.split("/").pop() ?? null,
    videoMtime: 0,
    subtitles: Array.from({ length: subtitleCount }, (_, i) => ({
      srtPath: `${videoPath}.${i}.srt`,
      srtName: `sub-${i}.srt`,
      tasks: [],
    })),
  };
}

const LIBRARY = [
  file("/media/downloads/Build Multi-Camera 3D Tracking with DeepStream.mp4"),
  file("/media/downloads/Ubiquiti/UniFi Design Center.mp4", 1),
  file("/media/downloads/developer/Boris Cherny Building Claude Code.mp4"),
  file("/media/downloads/Proxmox Datacenter Manager.mp4", 2),
];

test("no filter returns the library untouched", () => {
  assert.equal(filterLibraryFiles(LIBRARY), LIBRARY);
  assert.equal(filterLibraryFiles(LIBRARY, { query: "   " }).length, LIBRARY.length);
});

test("query matches file names case-insensitively", () => {
  const result = filterLibraryFiles(LIBRARY, { query: "PROXMOX" });
  assert.deepEqual(result.map((f) => f.videoName), ["Proxmox Datacenter Manager.mp4"]);
});

test("query matches folder names too", () => {
  // Searching by folder is how you narrow to one source directory.
  const result = filterLibraryFiles(LIBRARY, { query: "ubiquiti" });
  assert.deepEqual(result.map((f) => f.videoName), ["UniFi Design Center.mp4"]);
});

test("multiple terms all have to match", () => {
  assert.equal(filterLibraryFiles(LIBRARY, { query: "building claude" }).length, 1);
  assert.equal(filterLibraryFiles(LIBRARY, { query: "building proxmox" }).length, 0);
});

test("hiding subtitled files leaves only untranscribed ones", () => {
  const result = filterLibraryFiles(LIBRARY, { hideWithSubtitles: true });
  assert.deepEqual(result.map((f) => f.videoName), [
    "Build Multi-Camera 3D Tracking with DeepStream.mp4",
    "Boris Cherny Building Claude Code.mp4",
  ]);
});

test("query and subtitle filter combine", () => {
  assert.equal(filterLibraryFiles(LIBRARY, { query: "unifi", hideWithSubtitles: true }).length, 0);
  assert.equal(filterLibraryFiles(LIBRARY, { query: "deepstream", hideWithSubtitles: true }).length, 1);
});

test("hasSubtitles reflects the subtitle list", () => {
  assert.equal(hasSubtitles(file("/media/a.mp4")), false);
  assert.equal(hasSubtitles(file("/media/a.mp4", 1)), true);
});
