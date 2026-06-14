import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES } from "../app/constants";

type JsonObject = Record<string, unknown>;

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value as JsonObject).flatMap(([key, nested]) => flattenKeys(nested, prefix ? `${prefix}.${key}` : key));
}

function getNested(obj: unknown, dottedKey: string): unknown {
  return dottedKey.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) return undefined;
    return (current as JsonObject)[segment];
  }, obj);
}

function placeholders(value: string): string[] {
  return Array.from(value.matchAll(/{{\s*[^}]+\s*}}/g)).map((match) => match[0].replace(/\s+/g, ""));
}

function loadLocale(code: string): JsonObject {
  const file = join(process.cwd(), "src", "client", "locales", code, "translation.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

test("every language picker entry has a registered locale file", () => {
  for (const lang of LANGUAGES) {
    const locale = loadLocale(lang.code);
    assert.equal(typeof locale.nav, "object", `${lang.code} locale is missing nav keys`);
  }
});

test("all registered locales keep key parity with English", () => {
  const english = loadLocale("en");
  const englishKeys = flattenKeys(english).sort();

  for (const lang of LANGUAGES) {
    const locale = loadLocale(lang.code);
    const localeKeys = flattenKeys(locale).sort();
    assert.deepEqual(localeKeys, englishKeys, `${lang.code} locale keys differ from en`);
  }
});

test("translated strings preserve interpolation placeholders", () => {
  const english = loadLocale("en");
  const keys = flattenKeys(english);

  for (const lang of LANGUAGES) {
    const locale = loadLocale(lang.code);
    for (const key of keys) {
      const source = getNested(english, key);
      const translated = getNested(locale, key);
      if (typeof source !== "string" || typeof translated !== "string") continue;
      assert.deepEqual(placeholders(translated).sort(), placeholders(source).sort(), `${lang.code}.${key} placeholder mismatch`);
    }
  }
});

test("RTL locales are marked rtl and other bundled locales remain LTR", () => {
  const RTL_LOCALES = new Set(["ar", "fa", "he"]);
  for (const lang of LANGUAGES) {
    assert.equal(lang.dir, RTL_LOCALES.has(lang.code) ? "rtl" : "ltr", `${lang.code} has wrong direction`);
  }
});
