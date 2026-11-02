import { test } from "node:test";
import assert from "node:assert/strict";
import { findLanguage, LANGUAGES } from "./language-table";
import { resolveTargetLanguage, suggestLanguages } from "./resolve-language";

test("table has the critical entries with distinct zh variants", () => {
  assert.ok(findLanguage("zh-TW"));
  assert.ok(findLanguage("zh-CN"));
  assert.ok(findLanguage("ja"));
  const codes = LANGUAGES.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length, "codes must be unique");
});

test("resolves exact BCP-47 codes case-insensitively", () => {
  const r = resolveTargetLanguage("zh-tw");
  assert.equal(r.status, "resolved");
  assert.equal(r.status === "resolved" && r.language.code, "zh-TW");
  const r2 = resolveTargetLanguage("PT-br");
  assert.equal(r2.status === "resolved" && r2.language.code, "pt-BR");
});

test("resolves English names and native names", () => {
  const r = resolveTargetLanguage("Traditional Chinese");
  assert.equal(r.status === "resolved" && r.language.code, "zh-TW");
  const r2 = resolveTargetLanguage("日本語");
  assert.equal(r2.status === "resolved" && r2.language.code, "ja");
  const r3 = resolveTargetLanguage("繁體中文");
  assert.equal(r3.status === "resolved" && r3.language.code, "zh-TW");
});

test("bare Chinese is ambiguous, offering zh-CN and zh-TW — never a silent default", () => {
  for (const input of ["Chinese", "zh", "中文"]) {
    const r = resolveTargetLanguage(input);
    assert.equal(r.status, "ambiguous", `${input} should be ambiguous`);
    const codes = r.status === "ambiguous" ? r.options.map((o) => o.code) : [];
    assert.ok(codes.includes("zh-CN") && codes.includes("zh-TW"));
  }
});

test("unknown input yields close suggestions (typo tolerance)", () => {
  const r = resolveTargetLanguage("Japnese");
  assert.equal(r.status, "unknown");
  const codes = r.status === "unknown" ? r.suggestions.map((s) => s.code) : [];
  assert.ok(codes.includes("ja"), `expected ja among ${codes.join(",")}`);
});

test("empty or whitespace input is unknown with no suggestions", () => {
  const r = resolveTargetLanguage("   ");
  assert.equal(r.status, "unknown");
  assert.equal(r.status === "unknown" && r.suggestions.length, 0);
});

test("suggestLanguages filters for autocomplete by prefix and substring", () => {
  const byPrefix = suggestLanguages("jap").map((l) => l.code);
  assert.ok(byPrefix.includes("ja"));
  const byNative = suggestLanguages("繁").map((l) => l.code);
  assert.ok(byNative.includes("zh-TW"));
  const byCode = suggestLanguages("pt").map((l) => l.code);
  assert.ok(byCode.includes("pt-BR") && byCode.includes("pt-PT"));
  assert.deepEqual(suggestLanguages(""), []);
});
