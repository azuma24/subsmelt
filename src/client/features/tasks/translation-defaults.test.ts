import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AUTO_SOURCE_LANG,
  DEFAULT_LANG_CODE,
  DEFAULT_TARGET_LANG,
  LANGUAGE_OPTIONS,
  applyOutputFormat,
  applyTranslationPreset,
  createDefaultTranslationDraft,
  getTranslationPresetByLangCode,
} from "./translation-defaults";
import { LANGUAGES, PRESETS } from "../../app/constants";

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

test("target language dropdown options are generated from the translation preset catalog", () => {
  assert.equal(LANGUAGE_OPTIONS.length, PRESETS.length);
  assert.deepEqual(
    LANGUAGE_OPTIONS.map((option) => option.value),
    PRESETS.map((preset) => preset.lang_code),
  );
  assert.ok(LANGUAGE_OPTIONS.every((option) => option.label.includes(" · ")), "labels should show language and code together");
  assert.equal(getTranslationPresetByLangCode("jpn")?.target_lang, "Japanese");
});

test("choosing a language preset updates target language, language code, and recommended pattern together", () => {
  const draft = createDefaultTranslationDraft();
  const updated = applyTranslationPreset(draft, "kor");

  assert.equal(updated.source_lang, AUTO_SOURCE_LANG);
  assert.equal(updated.target_lang, "Korean");
  assert.equal(updated.lang_code, "kor");
  assert.equal(updated.output_pattern, "{{name}}.kor.srt");
});

test("translation sidebar uses the same Translations naming and URL", () => {
  const constants = readFileSync("src/client/app/constants.ts", "utf8");
  const app = readFileSync("src/client/App.tsx", "utf8");
  const dashboard = readFileSync("src/client/features/dashboard/DashboardPage.tsx", "utf8");

  assert.match(constants, /path: "\/translations", labelKey: "nav\.translations"/);
  assert.match(app, /<Route path="\/translations"/);
  assert.match(app, /<Route path="\/tasks" element={<Navigate to="\/translations" replace \/>} \/>/);
  assert.match(dashboard, /navigate\("\/translations"\)/);
});

test("automatic source detection copy is localized in all bundled locales", () => {
  const requiredKeys = ["sourceAutoBadge", "sourceAutoHelp", "targetLang"];
  for (const { code: locale } of LANGUAGES) {
    const raw = readFileSync(`src/client/locales/${locale}/translation.json`, "utf8");
    const data = JSON.parse(raw);
    for (const key of requiredKeys) {
      assert.equal(typeof data.translation_languages[key], "string", `${locale} missing ${key}`);
      assert.ok(data.translation_languages[key].length > 0, `${locale} empty ${key}`);
    }
  }
});
