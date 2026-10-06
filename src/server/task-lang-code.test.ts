import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.ts binds CONFIG_DIR at import; point it at a scratch folder first.
// The scratch config is disposable, so tasks created here need no cleanup.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-langcode-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
const config = await import("./config.js");

test("validateTaskLangCode rejects non-token codes and duplicates, accepts the rest", () => {
  const first = Number(
    config.createTask({
      source_lang: config.AUTO_SOURCE_LANGUAGE,
      target_lang: "Chinese",
      output_pattern: "{{name}}.{{lang_code}}.srt",
      lang_code: "zh",
    }).lastInsertRowid,
  );

  // Saved as the standard code: "zh" is Chinese, "chi".
  assert.equal(config.getTask(first)?.lang_code, "chi");
  // A second task with the same lang_code would write the same output files.
  assert.match(config.validateTaskLangCode("chi") ?? "", /already exists/);
  // Updating the owning task to its own code is fine.
  assert.equal(config.validateTaskLangCode("chi", first), null);

  // The code lands in file names: no traversal, no separators, no empties.
  assert.match(config.validateTaskLangCode("../../x") ?? "", /letters, digits/);
  assert.match(config.validateTaskLangCode("a/b") ?? "", /letters, digits/);
  assert.match(config.validateTaskLangCode("") ?? "", /letters, digits/);

  assert.equal(config.validateTaskLangCode("zh-Hans"), null);
  assert.equal(config.validateTaskLangCode("eng_v2"), null);
});

test("editing a task that kept an old spelling to avoid a duplicate never creates the duplicate", () => {
  for (const task of [...config.getTasks()]) config.deleteTask(task.id);
  const english = Number(config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang: "English", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "eng" }).lastInsertRowid);
  // A second English task, as an old config could hold it: written straight in, as loading leaves it.
  const second = Number(config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang: "Klingon", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "tlh" }).lastInsertRowid);
  Object.assign(config.getTask(second)!, { target_lang: "English", lang_code: "en" });

  config.updateTask(second, { enabled: 0 });

  assert.equal(config.getTask(second)?.lang_code, "en");
  assert.equal(config.getTask(english)?.lang_code, "eng");
});

test("a task moved to another language forgets the old language's codes", () => {
  for (const task of [...config.getTasks()]) config.deleteTask(task.id);
  const id = Number(config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang: "English", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "en" }).lastInsertRowid);
  config.updateTask(id, { lang_code: "en" });

  config.updateTask(id, { target_lang: "Korean", lang_code: "kor" });

  assert.equal(config.getTask(id)?.lang_code, "kor");
  assert.deepEqual(config.getTask(id)?.former_lang_codes ?? [], []);
});

test("a spelling change within one language keeps the old code for files already on disk", () => {
  for (const task of [...config.getTasks()]) config.deleteTask(task.id);
  const id = Number(config.createTask({ source_lang: config.AUTO_SOURCE_LANGUAGE, target_lang: "Klingon", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "tlh" }).lastInsertRowid);
  Object.assign(config.getTask(id)!, { target_lang: "English", lang_code: "en" });

  config.updateTask(id, { prompt_override: "Be brief." });

  assert.equal(config.getTask(id)?.lang_code, "eng");
  assert.deepEqual(config.getTask(id)?.former_lang_codes, ["en"]);
});
