import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUTO_SOURCE_LANG,
  DEFAULT_LANG_CODE,
  DEFAULT_TARGET_LANG,
  applyOutputFormat,
  createDefaultTranslationDraft,
} from "./translation-defaults";
import { PRESETS } from "../../app/constants";

test("new translation drafts default to automatic source detection and English output", () => {
  const draft = createDefaultTranslationDraft();

  assert.equal(draft.source_lang, AUTO_SOURCE_LANG);
  assert.equal(draft.target_lang, DEFAULT_TARGET_LANG);
  assert.equal(draft.lang_code, DEFAULT_LANG_CODE);
  assert.equal(applyOutputFormat(draft.output_pattern, "srt"), "{{name}}.{{lang_code}}.srt");
});

test("quick-add presets still use automatic source detection", () => {
  const japanese = PRESETS.find((preset) => preset.lang_code === "jpn");
  assert.ok(japanese);

  const draft = createDefaultTranslationDraft(japanese);

  assert.equal(draft.source_lang, AUTO_SOURCE_LANG);
  assert.equal(draft.target_lang, "Japanese");
  assert.equal(draft.lang_code, "jpn");
  assert.equal(draft.output_pattern, "{{name}}.jpn.srt");
});

test("English is available as a one-click Automatic → English target", () => {
  const english = PRESETS.find((preset) => preset.lang_code === "eng");
  assert.deepEqual(english, {
    label: "English",
    target_lang: "English",
    lang_code: "eng",
    output_pattern: "{{name}}.eng.srt",
  });
});

test("automatic source detection copy is localized in all bundled locales", () => {
  const requiredKeys = ["sourceAutoBadge", "sourceAutoHelp", "targetLang"];
  for (const locale of ["en", "ja", "zh-CN", "zh-TW"]) {
    const raw = readFileSync(`src/client/locales/${locale}/translation.json`, "utf8");
    const data = JSON.parse(raw);
    for (const key of requiredKeys) {
      assert.equal(typeof data.translation_languages[key], "string", `${locale} missing ${key}`);
      assert.ok(data.translation_languages[key].length > 0, `${locale} empty ${key}`);
    }
  }
});
