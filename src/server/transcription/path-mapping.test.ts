import test from "node:test";
import assert from "node:assert/strict";
import { buildTranscriptionRequest, resolveTransportMode } from "../transcription-client.js";

function mapped(to: string, videoPath = "/media/anime/Season 1/Episode 03.mkv"): string {
  return buildTranscriptionRequest({
    videoPath,
    mediaDir: "/media",
    settings: { transcription_path_map_from: "/media", transcription_path_map_to: to },
  }).input_path;
}

test("a Windows drive prefix maps with backslashes", () => {
  assert.equal(mapped("D:\\Media"), "D:\\Media\\anime\\Season 1\\Episode 03.mkv");
  assert.equal(mapped("D:\\Media\\"), "D:\\Media\\anime\\Season 1\\Episode 03.mkv");
  assert.equal(mapped("D:\\"), "D:\\anime\\Season 1\\Episode 03.mkv");
});

test("a Windows drive prefix written with forward slashes keeps them", () => {
  assert.equal(mapped("D:/Media"), "D:/Media/anime/Season 1/Episode 03.mkv");
});

test("a UNC share maps in either slash style and keeps its leading double slash", () => {
  assert.equal(mapped("\\\\nas\\media"), "\\\\nas\\media\\anime\\Season 1\\Episode 03.mkv");
  assert.equal(mapped("//nas/media"), "//nas/media/anime/Season 1/Episode 03.mkv");
});

test("a POSIX prefix still maps with forward slashes", () => {
  assert.equal(mapped("/srv/media-library"), "/srv/media-library/anime/Season 1/Episode 03.mkv");
  assert.equal(mapped("/"), "/anime/Season 1/Episode 03.mkv");
});

test("the media root itself maps to the prefix as written", () => {
  assert.equal(
    buildTranscriptionRequest({
      videoPath: "/media/Movie.mkv",
      mediaDir: "/media",
      settings: { transcription_path_map_from: "/media", transcription_path_map_to: "D:\\Media" },
    }).input_path,
    "D:\\Media\\Movie.mkv",
  );
});

test("relative, drive-relative and traversal backend prefixes are rejected", () => {
  for (const bad of ["Media", "D:Media", "\\Media", "\\\\nas", "D:\\Media\\..\\Windows", "//nas/../etc", "C://share"]) {
    assert.throws(() => mapped(bad), /absolute filesystem path|traversal/, bad);
  }
});

test("a file name carrying a backslash cannot traverse on a Windows backend", () => {
  assert.throws(() => mapped("D:\\Media", "/media/..\\..\\Windows\\x.mkv"), /cannot be mapped/);
});

test("a Windows mapping selects shared transport", () => {
  assert.equal(
    resolveTransportMode({
      transcription_backend_url: "http://192.168.1.20:8001",
      transcription_path_map_from: "/media",
      transcription_path_map_to: "D:\\Media",
    }),
    "shared",
  );
});
