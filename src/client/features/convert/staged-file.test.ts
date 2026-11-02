import test from "node:test";
import assert from "node:assert/strict";
import { effectiveSource, isSameAsTarget, skipTranslation, type StagedFile } from "./staged-file.js";

const staged = (over: Partial<StagedFile>): StagedFile => ({
  id: "a",
  file: {} as File,
  override: null,
  skip: false,
  detected: "en",
  ...over,
});

test("source resolution order is override, page-level From, then detection", () => {
  assert.equal(effectiveSource(staged({ override: "ja" }), "fr"), "ja");
  assert.equal(effectiveSource(staged({}), "fr"), "fr");
  assert.equal(effectiveSource(staged({}), ""), "en");
  assert.equal(effectiveSource(staged({ detected: null })), null);
});

test("the same-as-target warning appears only when translating into the detected source", () => {
  assert.equal(isSameAsTarget(staged({}), "", true, "en"), true);
  assert.equal(isSameAsTarget(staged({}), "", true, "ja"), false);
  assert.equal(isSameAsTarget(staged({}), "", false, "en"), false);
  assert.equal(isSameAsTarget(staged({}), "", true, null), false);
});

test("a skip ticked earlier is dropped once the checkbox is no longer offered", () => {
  const ticked = staged({ skip: true });
  assert.equal(skipTranslation(ticked, "", true, "en"), true);
  assert.equal(skipTranslation(ticked, "", true, "ja"), false, "target changed away from the source");
  assert.equal(skipTranslation({ ...ticked, override: "de" }, "", true, "en"), false, "override moved the source");
  assert.equal(skipTranslation(ticked, "", false, "en"), false, "format-only mode never skips");
});
