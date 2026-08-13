import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertMediaPathAllowed } from "./request.js";

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("a path inside the media dir is allowed", () => {
  const media = tmpdir("subsmelt-media-");
  const file = path.join(media, "show", "Episode 01.mkv");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", "utf8");

  assert.equal(assertMediaPathAllowed(file, media), fs.realpathSync(file));
});

test("a lexical traversal outside the media dir is rejected", () => {
  const media = tmpdir("subsmelt-media-");
  assert.throws(
    () => assertMediaPathAllowed(path.join(media, "..", "etc", "passwd"), media),
    /outside media directory/,
  );
});

test("a symlink inside the media dir cannot escape it", () => {
  // The lexical check passed this: the link's own path is under the media root,
  // so nothing noticed that following it lands outside.
  const media = tmpdir("subsmelt-media-");
  const outside = tmpdir("subsmelt-outside-");
  const secret = path.join(outside, "secret.mkv");
  fs.writeFileSync(secret, "", "utf8");

  const link = path.join(media, "escape.mkv");
  fs.symlinkSync(secret, link);

  assert.throws(() => assertMediaPathAllowed(link, media), /outside media directory/);
});

test("a symlinked media dir still accepts its own contents", () => {
  // Docker bind mounts routinely make MEDIA_DIR itself a symlink; resolving only
  // one side would then reject every legitimate path.
  const real = tmpdir("subsmelt-real-");
  const linkRoot = path.join(tmpdir("subsmelt-link-"), "media");
  fs.symlinkSync(real, linkRoot);

  const file = path.join(real, "Episode 02.mkv");
  fs.writeFileSync(file, "", "utf8");

  assert.equal(
    assertMediaPathAllowed(path.join(linkRoot, "Episode 02.mkv"), linkRoot),
    fs.realpathSync(file),
  );
});

test("a not-yet-created output path under the media dir is still allowed", () => {
  const media = tmpdir("subsmelt-media-");
  const pending = path.join(media, "show", "Episode 03.chi.srt");

  assert.equal(assertMediaPathAllowed(pending, media), path.join(fs.realpathSync(media), "show", "Episode 03.chi.srt"));
});
