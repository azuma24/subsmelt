/**
 * Canonical language table for the converter's free-text target input and
 * per-file source detection. `code` is BCP-47 and is what lands in output
 * filenames; `promptName` is the rich English name handed to the LLM prompt
 * (the translator pipeline takes language names, not codes).
 */

export interface LanguageEntry {
  code: string;
  englishName: string;
  nativeName: string;
  /** Name injected into the translation prompt as the target language. */
  promptName: string;
  /** Lowercased extra ways users type it (codes, short names, synonyms). */
  aliases: readonly string[];
  /** ISO 639-3 codes franc-min emits for this language. */
  franc: readonly string[];
}

export const LANGUAGES: readonly LanguageEntry[] = [
  { code: "en", englishName: "English", nativeName: "English", promptName: "English", aliases: ["eng"], franc: ["eng"] },
  { code: "ja", englishName: "Japanese", nativeName: "日本語", promptName: "Japanese", aliases: ["jpn", "jp"], franc: ["jpn"] },
  { code: "ko", englishName: "Korean", nativeName: "한국어", promptName: "Korean", aliases: ["kor"], franc: ["kor"] },
  { code: "zh-TW", englishName: "Traditional Chinese", nativeName: "繁體中文", promptName: "Traditional Chinese (Taiwan)", aliases: ["zh-hant", "cht", "taiwanese mandarin", "traditional chinese (taiwan)", "正體中文", "台灣中文"], franc: [] },
  { code: "zh-CN", englishName: "Simplified Chinese", nativeName: "简体中文", promptName: "Simplified Chinese", aliases: ["zh-hans", "chs", "简中", "簡中"], franc: [] },
  { code: "es", englishName: "Spanish", nativeName: "Español", promptName: "Spanish", aliases: ["spa", "castellano"], franc: ["spa"] },
  { code: "fr", englishName: "French", nativeName: "Français", promptName: "French", aliases: ["fra", "fre"], franc: ["fra"] },
  { code: "de", englishName: "German", nativeName: "Deutsch", promptName: "German", aliases: ["deu", "ger"], franc: ["deu"] },
  { code: "it", englishName: "Italian", nativeName: "Italiano", promptName: "Italian", aliases: ["ita"], franc: ["ita"] },
  { code: "pt-BR", englishName: "Brazilian Portuguese", nativeName: "Português (Brasil)", promptName: "Brazilian Portuguese", aliases: ["ptbr", "brazilian"], franc: ["por"] },
  { code: "pt-PT", englishName: "European Portuguese", nativeName: "Português (Portugal)", promptName: "European Portuguese", aliases: ["ptpt"], franc: [] },
  { code: "ru", englishName: "Russian", nativeName: "Русский", promptName: "Russian", aliases: ["rus"], franc: ["rus"] },
  { code: "ar", englishName: "Arabic", nativeName: "العربية", promptName: "Arabic", aliases: ["ara", "arb"], franc: ["arb"] },
  { code: "hi", englishName: "Hindi", nativeName: "हिन्दी", promptName: "Hindi", aliases: ["hin"], franc: ["hin"] },
  { code: "th", englishName: "Thai", nativeName: "ไทย", promptName: "Thai", aliases: ["tha"], franc: ["tha"] },
  { code: "vi", englishName: "Vietnamese", nativeName: "Tiếng Việt", promptName: "Vietnamese", aliases: ["vie"], franc: ["vie"] },
  { code: "id", englishName: "Indonesian", nativeName: "Bahasa Indonesia", promptName: "Indonesian", aliases: ["ind"], franc: ["ind"] },
  { code: "ms", englishName: "Malay", nativeName: "Bahasa Melayu", promptName: "Malay", aliases: ["msa", "zsm"], franc: ["zsm"] },
  { code: "tr", englishName: "Turkish", nativeName: "Türkçe", promptName: "Turkish", aliases: ["tur"], franc: ["tur"] },
  { code: "pl", englishName: "Polish", nativeName: "Polski", promptName: "Polish", aliases: ["pol"], franc: ["pol"] },
  { code: "nl", englishName: "Dutch", nativeName: "Nederlands", promptName: "Dutch", aliases: ["nld", "dut"], franc: ["nld"] },
  { code: "sv", englishName: "Swedish", nativeName: "Svenska", promptName: "Swedish", aliases: ["swe"], franc: ["swe"] },
  { code: "cs", englishName: "Czech", nativeName: "Čeština", promptName: "Czech", aliases: ["ces", "cze"], franc: ["ces"] },
  { code: "el", englishName: "Greek", nativeName: "Ελληνικά", promptName: "Greek", aliases: ["ell", "gre"], franc: ["ell"] },
  { code: "he", englishName: "Hebrew", nativeName: "עברית", promptName: "Hebrew", aliases: ["heb", "iw"], franc: ["heb"] },
  { code: "uk", englishName: "Ukrainian", nativeName: "Українська", promptName: "Ukrainian", aliases: ["ukr"], franc: ["ukr"] },
  { code: "ro", englishName: "Romanian", nativeName: "Română", promptName: "Romanian", aliases: ["ron", "rum"], franc: ["ron"] },
  { code: "hu", englishName: "Hungarian", nativeName: "Magyar", promptName: "Hungarian", aliases: ["hun"], franc: ["hun"] },
  { code: "fa", englishName: "Persian", nativeName: "فارسی", promptName: "Persian (Farsi)", aliases: ["fas", "per", "farsi"], franc: ["pes"] },
  { code: "fil", englishName: "Filipino", nativeName: "Filipino", promptName: "Filipino (Tagalog)", aliases: ["tl", "tgl", "tagalog"], franc: ["tgl"] },
  { code: "bn", englishName: "Bengali", nativeName: "বাংলা", promptName: "Bengali", aliases: ["ben"], franc: ["ben"] },
  { code: "ta", englishName: "Tamil", nativeName: "தமிழ்", promptName: "Tamil", aliases: ["tam"], franc: ["tam"] },
] as const;

/**
 * Inputs that legitimately mean "some Chinese" but must never silently pick a
 * script — the resolver returns these as an ambiguous choice instead.
 */
export const AMBIGUOUS_INPUTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["chinese", ["zh-CN", "zh-TW"]],
  ["zh", ["zh-CN", "zh-TW"]],
  ["中文", ["zh-CN", "zh-TW"]],
  ["汉语", ["zh-CN", "zh-TW"]],
  ["漢語", ["zh-CN", "zh-TW"]],
  ["mandarin", ["zh-CN", "zh-TW"]],
  ["portuguese", ["pt-BR", "pt-PT"]],
  ["português", ["pt-BR", "pt-PT"]],
  ["pt", ["pt-BR", "pt-PT"]],
]);

export function findLanguage(code: string): LanguageEntry | undefined {
  const needle = code.trim().toLowerCase();
  return LANGUAGES.find((l) => l.code.toLowerCase() === needle);
}

export function findLanguageByFranc(iso3: string): LanguageEntry | undefined {
  return LANGUAGES.find((l) => l.franc.includes(iso3));
}
