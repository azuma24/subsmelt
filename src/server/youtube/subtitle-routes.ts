/**
 * Which route gives each picked subtitle language, and the one table that
 * decides when two language labels mean the same language. YouTube says
 * "en-US" or "zh-Hant", Whisper says "en" or "zh", and a Translations task
 * says "eng" and "Traditional Chinese"; all of them resolve here.
 */

interface LanguageEntry {
  /** What the transcript file is named with: `<stem>.<file>.srt`. Two letters and an optional region, so the scanner strips it. */
  file: string;
  /** The code Whisper takes. */
  whisper: string;
  /** Codes and names that mean this language, lower case. */
  aliases: readonly string[];
}

// Chinese is three entries: a subtitle in Traditional characters is not one in
// Simplified, and a bare "zh" (what Whisper reports) promises neither.
const LANGUAGES: Record<string, LanguageEntry> = {
  en: { file: "en", whisper: "en", aliases: ["eng", "english"] },
  ja: { file: "ja", whisper: "ja", aliases: ["jp", "jpn", "japanese", "日本語"] },
  zh: { file: "zh", whisper: "zh", aliases: ["chi", "zho", "chinese", "中文"] },
  "zh-Hant": { file: "zh-TW", whisper: "zh", aliases: ["zh-tw", "zh-hk", "zh-mo", "cht", "zht", "traditional chinese", "chinese (traditional)", "繁體中文", "正體中文"] },
  "zh-Hans": { file: "zh-CN", whisper: "zh", aliases: ["zh-cn", "zh-sg", "chs", "zhs", "simplified chinese", "chinese (simplified)", "简体中文"] },
  ko: { file: "ko", whisper: "ko", aliases: ["kor", "korean", "한국어"] },
  fr: { file: "fr", whisper: "fr", aliases: ["fra", "fre", "french", "français"] },
  de: { file: "de", whisper: "de", aliases: ["deu", "ger", "german", "deutsch"] },
  es: { file: "es", whisper: "es", aliases: ["spa", "spanish", "español"] },
  pt: { file: "pt", whisper: "pt", aliases: ["por", "portuguese", "português", "brazilian portuguese"] },
  it: { file: "it", whisper: "it", aliases: ["ita", "italian", "italiano"] },
  ru: { file: "ru", whisper: "ru", aliases: ["rus", "russian", "русский"] },
  ar: { file: "ar", whisper: "ar", aliases: ["ara", "arabic", "العربية"] },
  th: { file: "th", whisper: "th", aliases: ["tha", "thai", "ไทย"] },
  vi: { file: "vi", whisper: "vi", aliases: ["vie", "vietnamese", "tiếng việt"] },
  id: { file: "id", whisper: "id", aliases: ["ind", "indonesian", "bahasa indonesia"] },
  nl: { file: "nl", whisper: "nl", aliases: ["nld", "dut", "dutch", "nederlands"] },
  pl: { file: "pl", whisper: "pl", aliases: ["pol", "polish", "polski"] },
  tr: { file: "tr", whisper: "tr", aliases: ["tur", "turkish", "türkçe"] },
  hi: { file: "hi", whisper: "hi", aliases: ["hin", "hindi", "हिन्दी"] },
  uk: { file: "uk", whisper: "uk", aliases: ["ukr", "ukrainian", "українська"] },
  sv: { file: "sv", whisper: "sv", aliases: ["swe", "swedish", "svenska"] },
};

const BY_ALIAS = new Map<string, string>();
for (const [key, entry] of Object.entries(LANGUAGES)) {
  for (const alias of [key.toLowerCase(), ...entry.aliases]) BY_ALIAS.set(alias, key);
}

const CHINESE_SCRIPT: Record<string, string> = { hant: "zh-Hant", tw: "zh-Hant", hk: "zh-Hant", mo: "zh-Hant", hans: "zh-Hans", cn: "zh-Hans", sg: "zh-Hans" };

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
  const bare = text.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  const stripped = bare ? BY_ALIAS.get(bare) : undefined;
  if (stripped) return stripped;
  const [base, ...rest] = text.split("-");
  if (base === "zh") {
    const script = rest.map((part) => CHINESE_SCRIPT[part]).find(Boolean);
    if (script) return script;
  }
  return BY_ALIAS.get(base) ?? text;
}

/** The suffix a transcript in this language is written with. */
export function languageFileCode(key: string): string {
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
  if (LANGUAGES[byName] && !(byName === "zh" && byCode.startsWith("zh-"))) return byName;
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
export function planSubtitles(spokenLang: string | null, targets: SubtitleTarget[], creatorCaptionLangs: string[]): SubtitleRoute[] {
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
    const captionLang = captions.get(key);
    return captionLang ? { taskId, kind: "captions", captionLang } : { taskId, kind: "translate" };
  });
}

/** The creator caption in the spoken language, if YouTube has one. */
export function spokenCaption(spokenLang: string | null, creatorCaptionLangs: string[]): string | null {
  if (!spokenLang) return null;
  const spoken = languageKey(spokenLang);
  return creatorCaptionLangs.find((caption) => caption !== "live_chat" && languageKey(caption) === spoken) ?? null;
}
