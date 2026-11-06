import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { promisify } from "node:util";

test("an intake walk larger than the probe cache reuses unchanged probes", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "subsmelt-intake-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const media = path.join(root, "media");
  mkdirSync(media);
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CONFIG_DIR = path.join(root, "config");
  process.env.MEDIA_DIR = media;

  let changedVideo: string | undefined;
  const probe = mock.fn(async (command: string, args: string[]) => {
    assert.equal(command, "ffprobe");
    const streams = args.at(-1) === changedVideo ? [{ index: 1, codec_name: "subrip", tags: { language: "fra" } }] : [];
    return { stdout: JSON.stringify({ streams }), stderr: "" };
  });
  // Stub subprocesses only. The scanner still walks and checks revisions on disk.
  const execFile = childProcess.execFile;
  childProcess.execFile = Object.defineProperty(execFile.bind(childProcess), promisify.custom, { value: probe });
  syncBuiltinESMExports();
  const { scanFolder } = await import("./scanner.js").finally(() => {
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
  });
  const { setSettings } = await import("./config.js");
  setSettings({ subtitle_intake_rules: JSON.stringify([{ path: "", language: "eng", fallback: "off" }]) });
  const now = Date.now;
  t.mock.method(Date, "now", () => now() + 10_000);
  const count = 2_049;
  for (let i = 0; i < count; i++) writeFileSync(path.join(media, `${i}.mkv`), "video");

  const options = { intake: "preview" as const, transcriptionAvailable: false };
  const first = await scanFolder(false, options);
  assert.equal(first.files.length, count);
  assert.ok(first.files.every(({ intake }) => intake?.action === "absent"));
  assert.equal(probe.mock.callCount(), count);

  probe.mock.resetCalls();
  const second = await scanFolder(false, options);
  assert.deepEqual(second, first);
  assert.equal(probe.mock.callCount(), 1);

  changedVideo = path.join(media, `${count - 1}.mkv`);
  writeFileSync(changedVideo, "replacement video");
  const replaced = await scanFolder(false, options);
  assert.equal(replaced.files.find(({ videoPath }) => videoPath === changedVideo)?.intake?.action, "language_mismatch");
});
