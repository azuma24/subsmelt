/**
 * The app's translator: English is bundled, every other language loads on
 * first use, and the choice is remembered under the key the previous
 * library used, so nobody's setting is lost by the switch.
 */
import { LANGUAGES } from "../app/constants";
import en from "../locales/en/translation.json";
import { type Bundle, createI18n } from "./core";

export type { Bundle, I18n, TFunction, TranslateOptions } from "./core";
export { createI18n, interpolate } from "./core";
export { I18nProvider, useTranslation } from "./react";

const STORAGE_KEY = "i18nextLng";

type LocaleLoader = () => Promise<{ default: Bundle }>;

const localeLoaders: Record<string, LocaleLoader> = {
  "zh-TW": () => import("../locales/zh-TW/translation.json"),
  "zh-CN": () => import("../locales/zh-CN/translation.json"),
  ja: () => import("../locales/ja/translation.json"),
  es: () => import("../locales/es/translation.json"),
  ko: () => import("../locales/ko/translation.json"),
  fr: () => import("../locales/fr/translation.json"),
  de: () => import("../locales/de/translation.json"),
  "pt-BR": () => import("../locales/pt-BR/translation.json"),
  it: () => import("../locales/it/translation.json"),
  ru: () => import("../locales/ru/translation.json"),
  ar: () => import("../locales/ar/translation.json"),
  hi: () => import("../locales/hi/translation.json"),
  id: () => import("../locales/id/translation.json"),
  vi: () => import("../locales/vi/translation.json"),
  th: () => import("../locales/th/translation.json"),
  tr: () => import("../locales/tr/translation.json"),
  pl: () => import("../locales/pl/translation.json"),
  nl: () => import("../locales/nl/translation.json"),
  "pt-PT": () => import("../locales/pt-PT/translation.json"),
  fa: () => import("../locales/fa/translation.json"),
  uk: () => import("../locales/uk/translation.json"),
  el: () => import("../locales/el/translation.json"),
  cs: () => import("../locales/cs/translation.json"),
  ro: () => import("../locales/ro/translation.json"),
  hu: () => import("../locales/hu/translation.json"),
  sv: () => import("../locales/sv/translation.json"),
  he: () => import("../locales/he/translation.json"),
  fil: () => import("../locales/fil/translation.json"),
  bn: () => import("../locales/bn/translation.json"),
  ms: () => import("../locales/ms/translation.json"),
  ta: () => import("../locales/ta/translation.json"),
};

const baseOf = (language: string) => language.toLowerCase().split("-")[0];

/** The bundled locale a requested language maps to: itself, the same base language, or English. */
export function resolveLocale(language: string): string {
  if (language === "en" || localeLoaders[language]) return language;
  const lower = language.toLowerCase();
  const exact = LANGUAGES.find((lang) => lang.code.toLowerCase() === lower);
  if (exact) return exact.code;
  // Chinese needs its script: zh, zh-Hant and zh-HK read as Traditional; zh-Hans and zh-SG as Simplified.
  if (baseOf(lower) === "zh") return /hans|sg|cn/.test(lower) ? "zh-CN" : "zh-TW";
  return LANGUAGES.find((lang) => baseOf(lang.code) === baseOf(lower))?.code ?? "en";
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The stored choice, else the first browser language the app has a locale for, else English. */
export function detectLanguage(): string {
  const stored = readStored();
  if (stored) return resolveLocale(stored);
  const wanted =
    typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const candidate of wanted) {
    if (!candidate) continue;
    const resolved = resolveLocale(candidate);
    if (resolved !== "en" || baseOf(candidate) === "en") return resolved;
  }
  return "en";
}

const i18n = createI18n({
  language: detectLanguage(),
  fallback: "en",
  bundles: { en: en as Bundle },
  load: async (language) => {
    const loader = localeLoaders[resolveLocale(language)];
    return loader ? (await loader()).default : null;
  },
});

i18n.on("languageChanged", () => {
  try {
    localStorage.setItem(STORAGE_KEY, i18n.language);
  } catch {
    // Private mode or storage disabled: the choice lasts for the session.
  }
});

export default i18n;
