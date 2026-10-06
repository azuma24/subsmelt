/**
 * Which route gives each picked subtitle language, and the one table that
 * decides when two language labels mean the same language. YouTube says
 * "en-US" or "zh-Hant", Whisper says "en" or "zh", and a Translations task
 * says "eng" and "Traditional Chinese"; all of them resolve here.
 */

interface LanguageEntry {
  /** What a subtitle in this language is named with: `<stem>.<file>.srt`. Three letters (ISO 639-2), so the scanner strips it. */
  file: string;
  /** The code Whisper takes. */
  whisper: string;
  /** Codes and names that mean this language, lower case. */
  aliases: readonly string[];
}

// Chinese is three entries (Bazarr writes Traditional as "zt"): a subtitle in Traditional characters is not one in
// Simplified, and a bare "zh" (what Whisper reports) promises neither. The
// user's preferred script is written as "chi" (see languageFileCode); the
// other one as "cht" or "chs".
const LANGUAGES: Record<string, LanguageEntry> = {
  en: { file: "eng", whisper: "en", aliases: ["eng", "english"] },
  ja: { file: "jpn", whisper: "ja", aliases: ["jp", "jpn", "japanese", "日本語"] },
  zh: { file: "chi", whisper: "zh", aliases: ["chi", "zho", "chinese", "中文"] },
  "zh-Hant": {
    file: "cht",
    whisper: "zh",
    aliases: [
      "zh-tw",
      "zh-hk",
      "zh-mo",
      "cht",
      "zht",
      "zt",
      "traditional chinese",
      "chinese (traditional)",
      "繁體中文",
      "正體中文",
    ],
  },
  "zh-Hans": {
    file: "chs",
    whisper: "zh",
    aliases: ["zh-cn", "zh-sg", "chs", "zhs", "simplified chinese", "chinese (simplified)", "简体中文"],
  },
  ko: { file: "kor", whisper: "ko", aliases: ["kor", "korean", "한국어"] },
  fr: { file: "fra", whisper: "fr", aliases: ["fra", "fre", "french", "français"] },
  de: { file: "deu", whisper: "de", aliases: ["deu", "ger", "german", "deutsch"] },
  es: { file: "spa", whisper: "es", aliases: ["spa", "spanish", "español"] },
  pt: { file: "por", whisper: "pt", aliases: ["por", "portuguese", "português"] },
  // Like Chinese scripts, Brazilian and European Portuguese are written differently enough to keep apart.
  "pt-BR": {
    file: "pt-BR",
    whisper: "pt",
    aliases: ["pt-br", "brazilian portuguese", "portuguese (brazil)", "português (brasil)", "português brasileiro"],
  },
  "pt-PT": {
    file: "pt-PT",
    whisper: "pt",
    aliases: ["pt-pt", "european portuguese", "portuguese (portugal)", "português (portugal)", "português europeu"],
  },
  it: { file: "ita", whisper: "it", aliases: ["ita", "italian", "italiano"] },
  ru: { file: "rus", whisper: "ru", aliases: ["rus", "russian", "русский"] },
  ar: { file: "ara", whisper: "ar", aliases: ["ara", "arabic", "العربية"] },
  th: { file: "tha", whisper: "th", aliases: ["tha", "thai", "ไทย"] },
  vi: { file: "vie", whisper: "vi", aliases: ["vie", "vietnamese", "tiếng việt"] },
  id: { file: "ind", whisper: "id", aliases: ["ind", "indonesian", "bahasa indonesia"] },
  nl: { file: "nld", whisper: "nl", aliases: ["nld", "dut", "dutch", "nederlands"] },
  pl: { file: "pol", whisper: "pl", aliases: ["pol", "polish", "polski"] },
  tr: { file: "tur", whisper: "tr", aliases: ["tur", "turkish", "türkçe"] },
  hi: { file: "hin", whisper: "hi", aliases: ["hin", "hindi", "हिन्दी"] },
  uk: { file: "ukr", whisper: "uk", aliases: ["ukr", "ukrainian", "українська"] },
  sv: { file: "swe", whisper: "sv", aliases: ["swe", "swedish", "svenska"] },
};

const BY_ALIAS = new Map<string, string>();
for (const [key, entry] of Object.entries(LANGUAGES)) {
  for (const alias of [key.toLowerCase(), ...entry.aliases]) BY_ALIAS.set(alias, key);
}

const CHINESE_SCRIPT: Record<string, string> = {
  hant: "zh-Hant",
  tw: "zh-Hant",
  hk: "zh-Hant",
  mo: "zh-Hant",
  hans: "zh-Hans",
  cn: "zh-Hans",
  sg: "zh-Hans",
};
// The languages whose region is part of the language, by the region subtag that picks each variant.
const REGIONAL: Record<string, Record<string, string>> = { zh: CHINESE_SCRIPT, pt: { br: "pt-BR", pt: "pt-PT" } };

/**
 * One key per language: "en-US", "eng" and "English" all give "en";
 * "zh-TW" and "zh-Hant-TW" give "zh-Hant". A region never matters except for
 * Chinese, where it names the script. Unknown labels come back lower-cased,
 * so two identical unknown labels still match.
 */
export function languageKey(label: string): string {
  const text = label.trim().toLowerCase().replace(/_/g, "-");
  const direct = BY_ALIAS.get(text);
  if (direct) return direct;
  // A parenthetical never names a language: "Traditional Chinese (Taiwan)" is "traditional chinese".
  const bare = text
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const stripped = bare ? BY_ALIAS.get(bare) : undefined;
  if (stripped) return stripped;
  const [base, ...rest] = text.split("-");
  const variants = REGIONAL[base];
  if (variants) {
    const variant = rest.map((part) => variants[part]).find(Boolean);
    if (variant) return variant;
  }
  return BY_ALIAS.get(base) ?? text;
}

/** Every code and name any language in the table can carry in a file name. */
export function allLanguageFileAliases(): string[] {
  return Object.keys(LANGUAGES).flatMap(languageFileAliases);
}

/** Whether the table knows this language key. */
export function isKnownLanguage(key: string): boolean {
  return key in LANGUAGES;
}

/** Every code and name that can appear in a file name for this language: its file code first. */
export function languageFileAliases(key: string): string[] {
  const entry = LANGUAGES[key];
  if (!entry) return [];
  return [entry.file, key, ...entry.aliases].filter((alias) => FILE_TOKEN_RE.test(alias));
}

// What a language suffix in a file name can be: no spaces, separators or other scripts.
const FILE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/** The script "Chinese" means for this user: Traditional (Taiwan) or Simplified. */
export type PreferredChinese = "zh-TW" | "zh-CN";

/** The table key of the preferred Chinese script. */
export function preferredChineseKey(preferred: PreferredChinese): string {
  return preferred === "zh-CN" ? "zh-Hans" : "zh-Hant";
}

/** The suffix a subtitle in this language is written with. Plain Chinese and the preferred script are both "chi". */
export function languageFileCode(key: string, preferred: PreferredChinese = "zh-TW"): string {
  if (key === preferredChineseKey(preferred)) return LANGUAGES.zh.file;
  return LANGUAGES[key]?.file ?? key;
}

/** The code to hand Whisper, or null when Whisper should detect the language. */
export function whisperLanguage(key: string): string | null {
  return LANGUAGES[key]?.whisper ?? (/^[a-z]{2}$/.test(key) ? key : null);
}

/** A Translations task's language: its name first, since "chi" says less than "Traditional Chinese". */
export function taskLanguageKey(task: { target_lang: string; lang_code: string }): string {
  const byName = languageKey(task.target_lang);
  const byCode = languageKey(task.lang_code);
  // A plain name ("Chinese", "Portuguese") with a code that picks a variant ("zh-TW", "pt-BR") means the variant.
  if (LANGUAGES[byName] && !(byName in REGIONAL && byCode.startsWith(`${byName}-`))) return byName;
  return byCode;
}

export interface SubtitleTarget {
  taskId: number;
  /** Any label the table knows: a code, a YouTube caption key, or a name. */
  lang: string;
}

export type SubtitleRoute =
  | { taskId: number; kind: "same" }
  | { taskId: number; kind: "captions"; captionLang: string }
  | { taskId: number; kind: "translate" };

/**
 * The cheapest route to each picked language. The transcript when the video
 * is already in it, the creator's captions when YouTube has them, otherwise a
 * translation of the transcript. `creatorCaptionLangs` are the keys of the
 * info JSON's `subtitles` (creator uploads only; YouTube's automatic
 * captions live elsewhere and never count).
 */
export function planSubtitles(
  spokenLang: string | null,
  targets: SubtitleTarget[],
  creatorCaptionLangs: string[],
): SubtitleRoute[] {
  const spoken = spokenLang ? languageKey(spokenLang) : null;
  const captions = new Map<string, string>();
  for (const caption of creatorCaptionLangs) {
    if (caption === "live_chat") continue;
    const key = languageKey(caption);
    if (!captions.has(key)) captions.set(key, caption);
  }
  return targets.map(({ taskId, lang }): SubtitleRoute => {
    const key = languageKey(lang);
    if (spoken && key === spoken) return { taskId, kind: "same" };
    // A plain "pt" task takes any Portuguese captions; a regional one ("pt-BR") only its own.
    const captionLang =
      captions.get(key) ?? (key in REGIONAL ? [...captions].find(([k]) => k.startsWith(`${key}-`))?.[1] : undefined);
    return captionLang ? { taskId, kind: "captions", captionLang } : { taskId, kind: "translate" };
  });
}

/** The creator caption in the spoken language, if YouTube has one. */
export function spokenCaption(spokenLang: string | null, creatorCaptionLangs: string[]): string | null {
  if (!spokenLang) return null;
  const spoken = languageKey(spokenLang);
  return creatorCaptionLangs.find((caption) => caption !== "live_chat" && languageKey(caption) === spoken) ?? null;
}
