import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findDownloadedMedia } from "./download.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-download-"));
}

test("the download is found by the bracketed id", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "Talk [abc123].mp4"), "x");
    assert.equal(findDownloadedMedia(dir, "abc123"), "Talk [abc123].mp4");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file saved with the bare id and no brackets is adopted", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "Talk abc123.m4a"), "x");
    assert.equal(findDownloadedMedia(dir, "abc123"), "Talk abc123.m4a");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("files without a media extension are ignored", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "Talk [abc123].txt"), "x");
    fs.writeFileSync(path.join(dir, "Talk [abc123].mp4.info.json"), "x");
    assert.equal(findDownloadedMedia(dir, "abc123"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
