import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Bundle, createI18n, interpolate } from "./core";

const locale = (code: string): Bundle =>
  JSON.parse(readFileSync(join(process.cwd(), "src", "client", "locales", code, "translation.json"), "utf8"));

test("keys are dotted paths, placeholders interpolate, and a missing key comes back as the key", () => {
  const i18n = createI18n({ language: "en", fallback: "en", bundles: { en: locale("en") } });
  assert.equal(i18n.t("nav.library"), "Library");
  assert.equal(i18n.t("nav.nope"), "nav.nope");
  assert.equal(i18n.t("nav.nope", { defaultValue: "Hello {{name}}", name: "Ann" }), "Hello Ann");
  assert.equal(interpolate("{{a}} and {{ b }} and {{c}}", { a: 1, b: "two" }), "1 and two and {{c}}");
  // The two shorthands components use: a default string, and a list of keys to try in order.
  assert.equal(i18n.t("nav.nope", "Fallback text"), "Fallback text");
  assert.equal(i18n.t(["nav.nope", "nav.library"]), "Library");
  assert.equal(i18n.t(["nav.nope", "nav.nope2"]), "nav.nope2");
});

test("plural forms follow each language's own categories, with _zero for a count of zero", () => {
  const en = createI18n({ language: "en", fallback: "en", bundles: { en: locale("en") } });
  const key = "settings.sources.dirRules.chipLangs";
  assert.equal(en.t(key, { count: 1 }), "1 language");
  assert.equal(en.t(key, { count: 3 }), "3 languages");
  assert.equal(en.t(key, { count: 0 }), "0 languages");

  const ru = createI18n({ language: "ru", fallback: "en", bundles: { en: locale("en"), ru: locale("ru") } });
  assert.equal(ru.t(key, { count: 1 }), "1 язык");
  assert.equal(ru.t(key, { count: 3 }), "3 языка");
  assert.equal(ru.t(key, { count: 5 }), "5 языков");
  assert.equal(ru.t(key, { count: 21 }), "21 язык");

  const ar = createI18n({ language: "ar", fallback: "en", bundles: { en: locale("en"), ar: locale("ar") } });
  const zeroKey = Object.entries(flatten(locale("ar"))).find(([key]) => key.endsWith("_zero"));
  assert.ok(zeroKey, "the Arabic bundle has a zero form");
  const base = zeroKey[0].replace(/_zero$/, "");
  assert.equal(ar.t(base, { count: 0 }), interpolate(zeroKey[1], { count: 0 }));
});

test("a key missing from the language falls back to its base language and then to English", () => {
  const i18n = createI18n({
    language: "pt-BR",
    fallback: "en",
    bundles: { en: { greeting: "Hello", only: "English" }, pt: { greeting: "Olá" }, "pt-BR": { bye: "Tchau" } },
  });
  assert.equal(i18n.t("bye"), "Tchau");
  assert.equal(i18n.t("greeting"), "Olá");
  assert.equal(i18n.t("only"), "English");
});

test("changing the language loads its bundle first and tells listeners", async () => {
  const loaded: string[] = [];
  const i18n = createI18n({
    language: "en",
    fallback: "en",
    bundles: { en: { hello: "Hello" } },
    load: async (language) => {
      loaded.push(language);
      return language === "de" ? { hello: "Hallo" } : null;
    },
  });
  const events: string[] = [];
  i18n.on("languageChanged", () => events.push(`changed:${i18n.language}`));
  i18n.on("loaded", () => events.push("loaded"));
  await i18n.changeLanguage("de");
  assert.equal(i18n.t("hello"), "Hallo");
  await i18n.changeLanguage("xx");
  assert.equal(i18n.t("hello"), "Hello", "a language with no bundle reads English");
  assert.deepEqual(loaded, ["de", "xx"]);
  assert.deepEqual(events, ["loaded", "changed:de", "changed:xx"]);
});

function flatten(bundle: Bundle, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bundle)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}
