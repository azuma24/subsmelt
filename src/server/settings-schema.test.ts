import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-settings-schema-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
const config = await import("./config.js");
const { readSettings, settingError, SETTINGS } = await import("./settings-schema.js");

test("the schema names exactly the settings the server stores", () => {
  const stored = Object.keys(config.getAllSettings()).sort();
  assert.deepEqual(Object.keys(SETTINGS).sort(), stored);
});

test("a save is checked by kind: flags, enums, numbers in range, JSON documents", () => {
  assert.equal(settingError("auto_translate", "1"), null);
  assert.equal(settingError("auto_translate", "yes"), "auto_translate must be 1 or 0");
  assert.equal(settingError("llm_mode", "parallel"), null);
  assert.equal(settingError("llm_mode", "round_robin"), "llm_mode must be one of single, fallback, parallel");
  assert.equal(settingError("chunk_size", "20"), null);
  assert.equal(settingError("chunk_size", "0"), "chunk_size must be a whole number from 1 to 500");
  assert.equal(settingError("temperature", "1e2"), "temperature must be a number from 0 to 2");
  assert.equal(settingError("directory_rules", "[]"), null);
  assert.equal(settingError("directory_rules", "[oops"), "directory_rules must be valid JSON");
  assert.equal(settingError("prompt", "anything goes"), null);
  assert.equal(settingError("not_a_setting", "x"), null);
});

test("readSettings returns typed values and falls back to the default for a bad stored value", () => {
  config.setSettings({ chunk_size: "25", refine_pass: "1", llm_mode: "fallback", temperature: "0.7" });
  let typed = readSettings();
  assert.equal(typed.chunk_size, 25);
  assert.equal(typed.refine_pass, true);
  assert.equal(typed.llm_mode, "fallback");
  assert.equal(typed.temperature, 0.7);
  assert.equal(typeof typed.prompt, "string");

  config.setSettings({ chunk_size: "lots", llm_mode: "sideways", parallel_chunks: "99" });
  typed = readSettings();
  assert.equal(typed.chunk_size, 20, "unparseable number falls back to the default");
  assert.equal(typed.llm_mode, "single", "unknown enum value falls back to the default");
  assert.equal(typed.parallel_chunks, 1, "out-of-range number falls back to the default");
});
