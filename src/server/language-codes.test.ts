import test from "node:test";
import assert from "node:assert/strict";
import { fileLangCodes, standardLangCode, standardizeTask, standardizeTasks, standardTaskLangCode } from "./language-codes.js";

test("every spelling of a language writes one standard code", () => {
  const cases: [string, string][] = [
    ["en", "eng"], ["eng", "eng"], ["English", "eng"], ["en-US", "eng"],
    ["ko", "kor"], ["kor", "kor"], ["Korean", "kor"],
    ["ja", "jpn"], ["jpn", "jpn"],
    ["zh-TW", "chi"], ["zh-tw", "chi"], ["cht", "chi"], ["zh-Hant", "chi"],
    ["zh-CN", "chs"], ["chs", "chs"],
    ["chi", "chi"], ["zho", "chi"],
  ];
  for (const [input, expected] of cases) assert.equal(standardLangCode(input), expected, input);
  // With Simplified preferred, Simplified is chi and Traditional is cht.
  assert.equal(standardLangCode("zh-TW", "zh-CN"), "cht");
  assert.equal(standardLangCode("zh-CN", "zh-CN"), "chi");
  assert.equal(standardLangCode("chi", "zh-CN"), "chi");
  // A code the table does not know is kept as typed.
  assert.equal(standardLangCode("fil"), "fil");
});

test("a task's language comes from its name first, so Traditional Chinese with chs is chi by default", () => {
  assert.equal(standardTaskLangCode({ target_lang: "Traditional Chinese", lang_code: "chs" }), "chi");
  assert.equal(standardTaskLangCode({ target_lang: "Traditional Chinese", lang_code: "chi" }, "zh-CN"), "cht");
  assert.equal(standardTaskLangCode({ target_lang: "English", lang_code: "en" }), "eng");
  assert.equal(standardTaskLangCode({ target_lang: "Korean", lang_code: "ko" }), "kor");
});

const task = (overrides: Partial<Parameters<typeof standardizeTask>[0]>) => ({
  id: 1, source_lang: "Automatic", target_lang: "English", output_pattern: "{{name}}.eng.srt", lang_code: "eng",
  enabled: 1, prompt_override: "", created_at: "2026-01-01T00:00:00.000Z", ...overrides,
});

test("an old task moves to the standard code and keeps its old one for files already on disk", () => {
  const standardized = standardizeTask(task({ lang_code: "en", output_pattern: "{{name}}.en.srt" }), []);
  assert.equal(standardized.lang_code, "eng");
  assert.equal(standardized.output_pattern, "{{name}}.{{lang_code}}.srt");
  assert.deepEqual(standardized.former_lang_codes, ["en"]);
  assert.deepEqual(standardizeTask(standardized, []), standardized);
});

test("a task already on the standard code is left alone", () => {
  const standard = task({});
  assert.deepEqual(standardizeTask(standard, []), standard);
});

test("a task keeps its code when the standard one belongs to another task", () => {
  const other = task({ id: 2, lang_code: "eng", output_pattern: "{{name}}.{{lang_code}}.srt" });
  assert.equal(standardizeTask(task({ lang_code: "en", output_pattern: "{{name}}.en.srt" }), [other]).lang_code, "en");
});

test("an output in any spelling of the task's language counts as that task's", () => {
  const codes = fileLangCodes({ target_lang: "Traditional Chinese", lang_code: "chi", former_lang_codes: ["zh-TW"] });
  for (const code of ["chi", "zh-TW", "zh-tw", "cht"]) assert.ok(codes.includes(code), code);
  assert.equal(codes[0], "chi");
  assert.ok(!fileLangCodes({ target_lang: "English", lang_code: "eng" }).includes("kor"));
});

test(".chi and .zh belong to the preferred Chinese script's task only", () => {
  const traditional = { target_lang: "Traditional Chinese", lang_code: "chi" };
  const simplified = { target_lang: "Simplified Chinese", lang_code: "chs" };
  for (const code of ["chi", "zh", "zho", "chinese"]) assert.ok(fileLangCodes(traditional).includes(code), code);
  assert.ok(!fileLangCodes(simplified).includes("chi"));
  assert.ok(!fileLangCodes(simplified, "zh-TW").includes("zh"));
  const preferredSimplified = { target_lang: "Simplified Chinese", lang_code: "chi" };
  for (const code of ["chi", "zh", "zho", "chinese"]) assert.ok(fileLangCodes(preferredSimplified, "zh-CN").includes(code), code);
  assert.ok(!fileLangCodes({ target_lang: "Traditional Chinese", lang_code: "cht" }, "zh-CN").includes("chi"));
});

test("Brazilian and European Portuguese keep their region, like Chinese scripts; plain Portuguese is por", () => {
  for (const [input, expected] of [["pt-BR", "pt-BR"], ["pt-br", "pt-BR"], ["Brazilian Portuguese", "pt-BR"], ["pt-PT", "pt-PT"], ["European Portuguese", "pt-PT"], ["pt", "por"], ["por", "por"], ["Portuguese", "por"]]) {
    assert.equal(standardLangCode(input), expected, input);
  }
  assert.equal(standardTaskLangCode({ target_lang: "Portuguese (Brazil)", lang_code: "pt" }), "pt-BR");
  assert.ok(!fileLangCodes({ target_lang: "Brazilian Portuguese", lang_code: "pt-BR" }).includes("pt-PT"));
});

test("a former code that now names the other Chinese script never counts", () => {
  // Traditional was chi while Traditional was preferred; with Simplified preferred it writes cht.
  const traditional = { target_lang: "Traditional Chinese", lang_code: "cht", former_lang_codes: ["chi", "zh-TW"] };
  const now = fileLangCodes(traditional, "zh-CN");
  for (const code of ["chi", "zh", "zho"]) assert.ok(!now.includes(code), code);
  for (const code of ["cht", "zh-TW"]) assert.ok(now.includes(code), code);
  // A former code of the same language, or one the table does not know, still counts.
  assert.ok(fileLangCodes({ target_lang: "English", lang_code: "eng", former_lang_codes: ["en", "english-subs"] }).includes("english-subs"));
  assert.ok(fileLangCodes({ target_lang: "English", lang_code: "eng", former_lang_codes: ["en"] }).includes("en"));
});

test("standardizing all tasks swaps the Chinese scripts' codes in one go", () => {
  const traditional = task({ id: 1, target_lang: "Traditional Chinese", lang_code: "chi", output_pattern: "{{name}}.{{lang_code}}.srt" });
  const simplified = task({ id: 2, target_lang: "Simplified Chinese", lang_code: "chs", output_pattern: "{{name}}.{{lang_code}}.srt" });
  const swapped = standardizeTasks([simplified, traditional], "zh-CN");
  assert.deepEqual(swapped.map((t) => t.lang_code), ["chi", "cht"]);
  assert.deepEqual(standardizeTasks(swapped, "zh-CN"), swapped);
  assert.deepEqual(standardizeTasks(swapped, "zh-TW").map((t) => t.lang_code), ["chs", "chi"]);
});
