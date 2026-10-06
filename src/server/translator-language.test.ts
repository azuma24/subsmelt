import assert from "node:assert/strict";
import test from "node:test";

import { buildTranslationSystemPrompt, isAutomaticSourceLanguage } from "./translator.js";

test("automatic source language values request source-language detection", () => {
  for (const sourceLang of [undefined, "", "Automatic", "auto", "auto-detect", "detect"]) {
    assert.equal(isAutomaticSourceLanguage(sourceLang), true);
  }
  assert.equal(isAutomaticSourceLanguage("Japanese"), false);
});

test("translation system prompt injects automatic source detection and target language", () => {
  const prompt = buildTranslationSystemPrompt({
    prompt: "Translate from {{source_lang}} into {{lang}}. Note: {{additional}}",
    sourceLang: "Automatic",
    lang: "English",
    additional: "Prefer concise subtitles.",
  });

  assert.match(prompt, /detect automatically/i);
  assert.match(prompt, /automatically detected/);
  assert.match(prompt, /English/);
  assert.match(prompt, /Prefer concise subtitles/);
});

test("translation system prompt always instructs tag and line-break preservation", () => {
  const prompt = buildTranslationSystemPrompt({
    prompt: "Translate into {{lang}}.",
    sourceLang: "Automatic",
    lang: "French",
    additional: "",
  });

  assert.match(prompt, /preserve/i);
  assert.match(prompt, /formatting tags/i);
  assert.match(prompt, /line breaks/i);
});

test("Traditional Chinese targets get Taiwan-convention instructions, others do not", () => {
  const zhTw = buildTranslationSystemPrompt({
    prompt: "Translate into {{lang}}.",
    sourceLang: "Automatic",
    lang: "Traditional Chinese (Taiwan)",
    additional: "",
  });
  assert.match(zhTw, /Taiwan/);
  assert.match(zhTw, /not .*mechanical/i);

  const french = buildTranslationSystemPrompt({
    prompt: "Translate into {{lang}}.",
    sourceLang: "Automatic",
    lang: "French",
    additional: "",
  });
  assert.doesNotMatch(french, /Taiwan/);
});

test("translation system prompt preserves explicit source languages for legacy custom tasks", () => {
  const prompt = buildTranslationSystemPrompt({
    prompt: "Translate from {{source_lang}} into {{lang}}.",
    sourceLang: "Japanese",
    lang: "English",
    additional: "",
  });

  assert.match(prompt, /Source subtitle language: Japanese/);
  assert.match(prompt, /Translate from Japanese into English/);
});
