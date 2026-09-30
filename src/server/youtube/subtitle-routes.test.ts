import test from "node:test";
import assert from "node:assert/strict";
import { languageFileCode, languageKey, planSubtitles, spokenCaption, taskLanguageKey, whisperLanguage } from "./subtitle-routes.js";

test("a video already in the picked language uses its transcript", () => {
  assert.deepEqual(planSubtitles("en", [{ taskId: 1, lang: "eng" }], []), [{ taskId: 1, kind: "same" }]);
});

test("creator captions in the picked language are downloaded under YouTube's own key", () => {
  assert.deepEqual(planSubtitles("en", [{ taskId: 2, lang: "zh-TW" }], ["en", "zh-Hant"]), [{ taskId: 2, kind: "captions", captionLang: "zh-Hant" }]);
});

test("without the language or its captions the transcript is translated", () => {
  assert.deepEqual(planSubtitles("en", [{ taskId: 3, lang: "Japanese" }], ["en", "zh-Hant"]), [{ taskId: 3, kind: "translate" }]);
});

test("one plan mixes the three routes, in the order the tasks were picked", () => {
  const targets = [{ taskId: 1, lang: "en" }, { taskId: 2, lang: "zh-Hant" }, { taskId: 3, lang: "ja" }];
  assert.deepEqual(planSubtitles("en-US", targets, ["en-US", "zh-TW", "live_chat"]), [
    { taskId: 1, kind: "same" },
    { taskId: 2, kind: "captions", captionLang: "zh-TW" },
    { taskId: 3, kind: "translate" },
  ]);
});

test("an unknown spoken language never counts as the same language", () => {
  assert.deepEqual(planSubtitles(null, [{ taskId: 1, lang: "en" }], []), [{ taskId: 1, kind: "translate" }]);
});

test("live chat replays are not captions", () => {
  assert.deepEqual(planSubtitles("ja", [{ taskId: 1, lang: "live_chat" }], ["live_chat"]), [{ taskId: 1, kind: "translate" }]);
});

test("code pairs that name one language resolve to one key", () => {
  const pairs: [string, string, string][] = [
    ["zh-TW", "zh-Hant", "zh-Hant"],
    ["zh-Hant-TW", "zh-HK", "zh-Hant"],
    ["zh-CN", "zh-Hans", "zh-Hans"],
    ["en", "eng", "en"],
    ["en-GB", "English", "en"],
    ["pt-BR", "pt", "pt"],
    ["ja", "jpn", "ja"],
    ["es-419", "spa", "es"],
    ["fre", "fr", "fr"],
    ["zh_TW", "cht", "zh-Hant"],
  ];
  for (const [a, b, key] of pairs) assert.deepEqual([languageKey(a), languageKey(b)], [key, key], `${a} and ${b}`);
});

test("Traditional, Simplified and unspecified Chinese stay apart", () => {
  assert.deepEqual([languageKey("zh-TW"), languageKey("zh-CN"), languageKey("zh")], ["zh-Hant", "zh-Hans", "zh"]);
  assert.deepEqual(planSubtitles("zh", [{ taskId: 1, lang: "zh-Hant" }], []), [{ taskId: 1, kind: "translate" }]);
});

test("unknown labels match only themselves", () => {
  assert.deepEqual([languageKey("Tlh"), languageKey("tlh-x")], ["tlh", "tlh-x"]);
});

test("a task names its language by name first, unless the name is plain Chinese and the code picks a script", () => {
  assert.equal(taskLanguageKey({ target_lang: "Traditional Chinese", lang_code: "chi" }), "zh-Hant");
  assert.equal(taskLanguageKey({ target_lang: "Chinese", lang_code: "chs" }), "zh-Hans");
  assert.equal(taskLanguageKey({ target_lang: "English", lang_code: "eng" }), "en");
  assert.equal(taskLanguageKey({ target_lang: "Klingon", lang_code: "tlh" }), "tlh");
});

test("transcripts are named with a suffix the scanner strips, and Whisper gets the base language", () => {
  assert.deepEqual([languageFileCode("zh-Hant"), languageFileCode("en"), languageFileCode("tlh")], ["zh-TW", "en", "tlh"]);
  assert.deepEqual([whisperLanguage("zh-Hant"), whisperLanguage("pt"), whisperLanguage("fil"), whisperLanguage("sw")], ["zh", "pt", null, "sw"]);
});

test("the spoken-language caption is found under any spelling", () => {
  assert.equal(spokenCaption("en", ["live_chat", "de", "en-US"]), "en-US");
  assert.equal(spokenCaption("en", ["de"]), null);
  assert.equal(spokenCaption(null, ["en"]), null);
});
