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

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

// English pluralises with `_one`/`_other`; other languages need the CLDR
// categories their own rules produce (Russian `_few`/`_many`, Arabic all six).
// Splits English's keys into plain keys and the bases of its plural groups.
function englishKeyShape(englishKeys: string[]): { plain: string[]; pluralBases: string[] } {
  const keys = new Set(englishKeys);
  const pluralBases = englishKeys
    .filter((key) => key.endsWith("_other") && keys.has(key.replace(/_other$/, "_one")))
    .map((key) => key.replace(/_other$/, ""));
  const bases = new Set(pluralBases);
  const plain = englishKeys.filter((key) => !(PLURAL_SUFFIX.test(key) && bases.has(key.replace(PLURAL_SUFFIX, ""))));
  return { plain, pluralBases };
}

function pluralCategories(code: string): string[] {
  return new Intl.PluralRules(code).resolvedOptions().pluralCategories;
}

test("all registered locales keep key parity with English", () => {
  const english = loadLocale("en");
  const { plain, pluralBases } = englishKeyShape(flattenKeys(english));
  const englishCategories = pluralCategories("en");

  for (const lang of LANGUAGES) {
    const localeKeys = new Set(flattenKeys(loadLocale(lang.code)));
    const required = pluralCategories(lang.code);
    // English's own `_one` stays tolerated in languages without a "one"
    // category (Japanese, Chinese...): i18next never reads it, and removing
    // it buys nothing.
    const allowed = new Set([...required, ...englishCategories]);

    const missing = [
      ...plain.filter((key) => !localeKeys.has(key)),
      ...pluralBases.flatMap((base) => required.map((cat) => `${base}_${cat}`).filter((key) => !localeKeys.has(key))),
    ];
    const plainSet = new Set(plain);
    const pluralBaseSet = new Set(pluralBases);
    const extra = [...localeKeys].filter((key) => {
      if (plainSet.has(key)) return false;
      const match = PLURAL_SUFFIX.exec(key);
      return !(match && pluralBaseSet.has(key.slice(0, match.index)) && allowed.has(match[1]));
    });
    assert.deepEqual(missing, [], `${lang.code} is missing keys (plural categories: ${required.join(", ")})`);
    assert.deepEqual(extra, [], `${lang.code} has keys English does not`);
  }
});

test("extra plural forms keep the placeholders of the English plural", () => {
  const english = loadLocale("en");
  const { pluralBases } = englishKeyShape(flattenKeys(english));

  for (const lang of LANGUAGES) {
    const locale = loadLocale(lang.code);
    for (const base of pluralBases) {
      const source = getNested(english, `${base}_other`) as string;
      for (const cat of pluralCategories(lang.code)) {
        const translated = getNested(locale, `${base}_${cat}`);
        if (typeof translated !== "string") continue;
        assert.deepEqual(placeholders(translated).sort(), placeholders(source).sort(), `${lang.code}.${base}_${cat} placeholder mismatch`);
      }
    }
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

test("shared query-state error keys survive taxonomy additions", () => {
  // Regression guard: a locale script that REPLACED the `errors` object wiped
  // these, and every consumer (QueryState, JobDetailPage, AppErrorBoundary)
  // silently rendered raw key names instead. Parity alone cannot catch it —
  // when every locale loses the same key they still match each other.
  const SHARED_KEYS = ["loading", "loadFailed", "retry", "reload", "boundaryTitle", "boundaryMessage"];
  for (const lang of LANGUAGES) {
    const locale = loadLocale(lang.code);
    const errors = locale.errors as JsonObject;
    assert.equal(typeof errors, "object", `${lang.code} is missing the errors section`);
    for (const key of SHARED_KEYS) {
      assert.equal(typeof errors[key], "string", `${lang.code} lost errors.${key}`);
    }
  }
});

test("error messages are translated in every non-English locale", () => {
  const english = loadLocale("en");
  const errorKeys = flattenKeys(english.errors, "errors");
  const untranslated: string[] = [];

  for (const lang of LANGUAGES) {
    if (lang.code === "en") continue;
    const locale = loadLocale(lang.code);
    for (const key of errorKeys) {
      if (getNested(locale, key) === getNested(english, key)) untranslated.push(`${lang.code}.${key}`);
    }
  }
  assert.deepEqual(untranslated, [], `errors.* values still identical to English:\n${untranslated.join("\n")}`);
});

test("RTL locales are marked rtl and other bundled locales remain LTR", () => {
  const RTL_LOCALES = new Set(["ar", "fa", "he"]);
  for (const lang of LANGUAGES) {
    assert.equal(lang.dir, RTL_LOCALES.has(lang.code) ? "rtl" : "ltr", `${lang.code} has wrong direction`);
  }
});
