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
      lang_code: "chi",
    }).lastInsertRowid,
  );

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
