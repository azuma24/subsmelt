import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en/translation.json";

type LocaleModule = { default: Record<string, unknown> };
type LocaleLoader = () => Promise<LocaleModule>;

const localeLoaders: Record<string, LocaleLoader> = {
  "zh-TW": () => import("./locales/zh-TW/translation.json"),
  "zh-CN": () => import("./locales/zh-CN/translation.json"),
  ja: () => import("./locales/ja/translation.json"),
  es: () => import("./locales/es/translation.json"),
  ko: () => import("./locales/ko/translation.json"),
  fr: () => import("./locales/fr/translation.json"),
  de: () => import("./locales/de/translation.json"),
  "pt-BR": () => import("./locales/pt-BR/translation.json"),
  it: () => import("./locales/it/translation.json"),
  ru: () => import("./locales/ru/translation.json"),
  ar: () => import("./locales/ar/translation.json"),
  hi: () => import("./locales/hi/translation.json"),
  id: () => import("./locales/id/translation.json"),
  vi: () => import("./locales/vi/translation.json"),
  th: () => import("./locales/th/translation.json"),
  tr: () => import("./locales/tr/translation.json"),
  pl: () => import("./locales/pl/translation.json"),
  nl: () => import("./locales/nl/translation.json"),
  "pt-PT": () => import("./locales/pt-PT/translation.json"),
  fa: () => import("./locales/fa/translation.json"),
  uk: () => import("./locales/uk/translation.json"),
  el: () => import("./locales/el/translation.json"),
  cs: () => import("./locales/cs/translation.json"),
  ro: () => import("./locales/ro/translation.json"),
  hu: () => import("./locales/hu/translation.json"),
  sv: () => import("./locales/sv/translation.json"),
  he: () => import("./locales/he/translation.json"),
  fil: () => import("./locales/fil/translation.json"),
  bn: () => import("./locales/bn/translation.json"),
  ms: () => import("./locales/ms/translation.json"),
  ta: () => import("./locales/ta/translation.json"),
};

function baseLanguage(language: string): string {
  return language.toLowerCase().split("-")[0];
}

function resolveLocale(language: string): string {
  if (language === "zh-TW" || language === "zh-CN" || localeLoaders[language]) return language;
  const match = Object.keys(localeLoaders).find((locale) => baseLanguage(locale) === baseLanguage(language));
  return match ?? "en";
}

const loading = new Map<string, Promise<void>>();

function loadLocale(language: string): Promise<void> {
  const locale = resolveLocale(language);
  if (locale === "en" || i18n.hasResourceBundle(locale, "translation")) return Promise.resolve();
  const existing = loading.get(locale);
  if (existing) return existing;

  const loader = localeLoaders[locale];
  if (!loader) return Promise.resolve();
  const request = loader()
    .then((module) => {
      i18n.addResourceBundle(locale, "translation", module.default, true, true);
    })
    .finally(() => {
      loading.delete(locale);
    });
  loading.set(locale, request);
  return request;
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

i18n.on("languageChanged", (language) => {
  void loadLocale(language);
});

void loadLocale(i18n.language);

export default i18n;
