import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROGRESS_SUFFIX,
  applyResumedTranslations,
  chunkFullyTranslated,
  clearPartialArtifacts,
  isPartialProgress,
  loadPartialProgress,
  partialProgressPath,
  savePartialProgress,
  snapshotTranslations,
} from "./partial-resume.js";
import type { SubtitleCue } from "./utils.js";

function cue(text: string, translatedText?: string): SubtitleCue {
  return {
    type: "cue",
    data: {
      text,
      ...(translatedText !== undefined ? { translatedText } : {}),
    },
  } as SubtitleCue;
}

test("partialProgressPath sits beside the output with a distinct suffix", () => {
  const output = "/media/show/Episode 01.chi.srt";
  assert.equal(partialProgressPath(output), `${output}${PROGRESS_SUFFIX}`);
  assert.notEqual(partialProgressPath(output), `${output}.part`);
});

test("isPartialProgress rejects corrupt or mismatched payloads", () => {
  assert.equal(isPartialProgress(null), false);
  assert.equal(isPartialProgress({ version: 1, totalCues: 2, translations: ["a"] }), false);
  assert.equal(
    isPartialProgress({ version: 1, totalCues: 2, translations: ["a", null] }),
    true,
  );
});

test("save/load round-trip restores translations and clear removes both artifacts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-resume-"));
  const output = path.join(dir, "Episode 01.chi.srt");
  const partial = `${output}.part`;
  fs.writeFileSync(partial, "partial body", "utf8");

  savePartialProgress(output, {
    version: 1,
    totalCues: 3,
    translations: ["你好", null, "世界"],
  });

  const loaded = loadPartialProgress(output, 3);
  assert.ok(loaded);
  assert.deepEqual(loaded.translations, ["你好", null, "世界"]);
  assert.equal(loadPartialProgress(output, 2), null, "cue-count mismatch must discard progress");

  clearPartialArtifacts(output, partial);
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.existsSync(partialProgressPath(output)), false);
});

test("applyResumedTranslations and snapshotTranslations are inverses for filled cues", () => {
  const cues = [cue("Hello"), cue("World"), cue("!")];
  const restored = applyResumedTranslations(cues, ["你好", null, "！"]);
  assert.equal(restored, 2);
  assert.equal(cues[0].data?.translatedText, "你好");
  assert.equal(cues[1].data?.translatedText, undefined);
  assert.equal(cues[2].data?.translatedText, "！");
  assert.deepEqual(snapshotTranslations(cues), ["你好", null, "！"]);
});

test("chunkFullyTranslated only when every cue already has translatedText", () => {
  assert.equal(chunkFullyTranslated([]), false);
  assert.equal(chunkFullyTranslated([cue("a", "A"), cue("b", "B")]), true);
  assert.equal(chunkFullyTranslated([cue("a", "A"), cue("b")]), false);
});
