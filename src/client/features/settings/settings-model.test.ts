import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  getBool,
  getStr,
  isJsonBlobSetting,
  validateJsonSetting,
  type ClientSettings,
} from "./settings-model";

test("getStr returns string values and falls back otherwise", () => {
  const s: ClientSettings = { model: "qwen", temperature: undefined };
  assert.equal(getStr(s, "model"), "qwen");
  assert.equal(getStr(s, "temperature", "0.7"), "0.7");
  assert.equal(getStr(s, "missing"), "");
  assert.equal(getStr(s, "missing", "x"), "x");
  // non-string value → fallback
  assert.equal(getStr({ _watcher_running: true }, "_watcher_running", "fb"), "fb");
});

test("getBool reads string-booleans and real booleans", () => {
  assert.equal(getBool({ refine_pass: "1" }, "refine_pass"), true);
  assert.equal(getBool({ refine_pass: "0" }, "refine_pass"), false);
  assert.equal(getBool({ _watcher_running: true }, "_watcher_running"), true);
  assert.equal(getBool({ _watcher_running: false }, "_watcher_running"), false);
  assert.equal(getBool({}, "refine_pass"), false);
  assert.equal(getBool({}, "refine_pass", true), true);
  // arbitrary string that isn't "1" → false
  assert.equal(getBool({ auto_translate: "yes" }, "auto_translate"), false);
});

test("isJsonBlobSetting recognizes only the two blob keys", () => {
  assert.equal(isJsonBlobSetting("transcription_folder_defaults"), true);
  assert.equal(isJsonBlobSetting("transcription_advanced_stt"), true);
  assert.equal(isJsonBlobSetting("model"), false);
});

test("validateJsonSetting: folder_defaults must be an array", () => {
  assert.deepEqual(validateJsonSetting("transcription_folder_defaults", "[]"), { ok: true });
  assert.deepEqual(
    validateJsonSetting("transcription_folder_defaults", '[{"path":"/m"}]'),
    { ok: true },
  );
  // empty/whitespace is allowed (normalized to default on save)
  assert.deepEqual(validateJsonSetting("transcription_folder_defaults", "   "), { ok: true });

  const obj = validateJsonSetting("transcription_folder_defaults", "{}");
  assert.equal(obj.ok, false);
  if (!obj.ok) assert.equal(obj.error, "expectedArray");

  const bad = validateJsonSetting("transcription_folder_defaults", "[not json");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.error.startsWith("invalidJson:"));
});

test("validateJsonSetting: advanced_stt must be a plain object", () => {
  assert.deepEqual(validateJsonSetting("transcription_advanced_stt", "{}"), { ok: true });
  assert.deepEqual(
    validateJsonSetting("transcription_advanced_stt", '{"beam_size":5}'),
    { ok: true },
  );
  assert.deepEqual(validateJsonSetting("transcription_advanced_stt", ""), { ok: true });

  const arr = validateJsonSetting("transcription_advanced_stt", "[]");
  assert.equal(arr.ok, false);
  if (!arr.ok) assert.equal(arr.error, "expectedObject");

  const nul = validateJsonSetting("transcription_advanced_stt", "null");
  assert.equal(nul.ok, false);
  if (!nul.ok) assert.equal(nul.error, "expectedObject");

  const bad = validateJsonSetting("transcription_advanced_stt", "{oops}");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.error.startsWith("invalidJson:"));
});

test("validateJsonSetting: non-blob keys are always valid", () => {
  assert.deepEqual(validateJsonSetting("model", "anything at all"), { ok: true });
});
