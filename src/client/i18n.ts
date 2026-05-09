import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en/translation.json";
import zhTW from "./locales/zh-TW/translation.json";
import zhCN from "./locales/zh-CN/translation.json";
import ja from "./locales/ja/translation.json";
import es from "./locales/es/translation.json";
import ko from "./locales/ko/translation.json";
import fr from "./locales/fr/translation.json";
import de from "./locales/de/translation.json";
import ptBR from "./locales/pt-BR/translation.json";
import it from "./locales/it/translation.json";
import ru from "./locales/ru/translation.json";
import ar from "./locales/ar/translation.json";
import hi from "./locales/hi/translation.json";
import id from "./locales/id/translation.json";
import vi from "./locales/vi/translation.json";
import th from "./locales/th/translation.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "zh-TW": { translation: zhTW },
      "zh-CN": { translation: zhCN },
      "ja": { translation: ja },
      "es": { translation: es },
      "ko": { translation: ko },
      "fr": { translation: fr },
      "de": { translation: de },
      "pt-BR": { translation: ptBR },
      "it": { translation: it },
      "ru": { translation: ru },
      "ar": { translation: ar },
      "hi": { translation: hi },
      "id": { translation: id },
      "vi": { translation: vi },
      "th": { translation: th },
    },
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

export default i18n;
