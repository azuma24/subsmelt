import type { IconName } from "../ui/Icon";

export const LANGUAGES = [
  { code: "en", label: "English", dir: "ltr" },
  { code: "zh-TW", label: "繁體中文", dir: "ltr" },
  { code: "zh-CN", label: "简体中文", dir: "ltr" },
  { code: "ja", label: "日本語", dir: "ltr" },
  { code: "es", label: "Español", dir: "ltr" },
  { code: "ko", label: "한국어", dir: "ltr" },
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "de", label: "Deutsch", dir: "ltr" },
  { code: "pt-BR", label: "Português (Brasil)", dir: "ltr" },
  { code: "it", label: "Italiano", dir: "ltr" },
  { code: "ru", label: "Русский", dir: "ltr" },
  { code: "ar", label: "العربية", dir: "rtl" },
  { code: "hi", label: "हिन्दी", dir: "ltr" },
  { code: "id", label: "Bahasa Indonesia", dir: "ltr" },
  { code: "vi", label: "Tiếng Việt", dir: "ltr" },
  { code: "th", label: "ไทย", dir: "ltr" },
  { code: "tr", label: "Türkçe", dir: "ltr" },
  { code: "pl", label: "Polski", dir: "ltr" },
  { code: "nl", label: "Nederlands", dir: "ltr" },
  { code: "pt-PT", label: "Português (Portugal)", dir: "ltr" },
  { code: "fa", label: "فارسی", dir: "rtl" },
  { code: "uk", label: "Українська", dir: "ltr" },
  { code: "el", label: "Ελληνικά", dir: "ltr" },
  { code: "cs", label: "Čeština", dir: "ltr" },
  { code: "ro", label: "Română", dir: "ltr" },
  { code: "hu", label: "Magyar", dir: "ltr" },
  { code: "sv", label: "Svenska", dir: "ltr" },
  { code: "he", label: "עברית", dir: "rtl" },
  { code: "fil", label: "Filipino", dir: "ltr" },
  { code: "bn", label: "বাংলা", dir: "ltr" },
  { code: "ms", label: "Bahasa Melayu", dir: "ltr" },
  { code: "ta", label: "தமிழ்", dir: "ltr" },
] as const;

/** Sidebar sections, rendered in this order. The grouping is data, not JSX:
 *  `operate` is the library and the live queue, `create` holds the tools that
 *  produce new subtitles, and `system` is configuration. That last group is
 *  labelled "System" rather than "Configure" because several locales translate
 *  "Configure" to the same word as the Settings item itself (es
 *  "Configuración", pt "Configurações"), which reads as a duplicate. */
export const NAV_GROUPS = [
  { id: "operate", labelKey: "nav.groupOperate" },
  { id: "create", labelKey: "nav.groupCreate" },
  { id: "system", labelKey: "nav.groupSystem" },
] as const;

export type NavGroupId = (typeof NAV_GROUPS)[number]["id"];

/** Every destination, in order. The phone bottom bar shows all of them, so the
 *  list stays at five; Convert, Languages and Logs are reached from the
 *  Library header and Settings instead. */
export const NAV_ITEMS = [
  { path: "/", labelKey: "nav.library", icon: "library", group: "operate" },
  { path: "/activity", labelKey: "nav.activity", icon: "activity", group: "operate" },
  { path: "/whisper", labelKey: "nav.whisper", icon: "transcribe", group: "create" },
  { path: "/youtube", labelKey: "nav.youtube", icon: "youtube", group: "create" },
  { path: "/settings", labelKey: "nav.settings", icon: "settings", group: "system" },
] as const;

export type NavItem = (typeof NAV_ITEMS)[number];

export const navItemsInGroup = (group: NavGroupId): readonly NavItem[] =>
  NAV_ITEMS.filter((item) => item.group === group);

/** Sub-routes (/settings/logs) keep their parent item active; "/" matches only itself. */
export function isNavActive(item: NavItem, currentPath: string): boolean {
  if (item.path === "/") return currentPath === "/";
  return currentPath === item.path || currentPath.startsWith(`${item.path}/`);
}

export const STATUS_ICON: Record<string, IconName> = {
  done: "done",
  pending: "pending",
  translating: "running",
  error: "error",
  // "Skipped" is actionable, not inert: it means the file was never translated
  // (an existing target subtitle was found). The glyph has to read differently
  // from `pending` and `done` so the badge is not mistaken for either.
  skipped: "skipped",
  new: "new",
};

export const STATUS_LABEL_KEY: Record<string, string> = {
  done: "dashboard.status.done",
  pending: "dashboard.status.pending",
  translating: "dashboard.status.translating",
  error: "dashboard.status.error",
  skipped: "dashboard.status.skipped",
  new: "dashboard.status.new",
};

// Standard codes: three letters (ISO 639-2). Traditional Chinese is chi here; the server writes
// whichever script the user prefers as chi and the other as chs or cht.
export const PRESETS = [
  { label: "English", target_lang: "English", lang_code: "eng", output_pattern: "{{name}}.{{lang_code}}.srt" },
  {
    label: "繁體中文",
    target_lang: "Traditional Chinese (Taiwan)",
    lang_code: "chi",
    output_pattern: "{{name}}.{{lang_code}}.srt",
  },
  { label: "日本語", target_lang: "Japanese", lang_code: "jpn", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "한국어", target_lang: "Korean", lang_code: "kor", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "Español", target_lang: "Spanish", lang_code: "spa", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "Français", target_lang: "French", lang_code: "fra", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "Deutsch", target_lang: "German", lang_code: "deu", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "Português", target_lang: "Portuguese", lang_code: "por", output_pattern: "{{name}}.{{lang_code}}.srt" },
  {
    label: "简体中文",
    target_lang: "Simplified Chinese",
    lang_code: "chs",
    output_pattern: "{{name}}.{{lang_code}}.srt",
  },
  { label: "Русский", target_lang: "Russian", lang_code: "rus", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "العربية", target_lang: "Arabic", lang_code: "ara", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "ไทย", target_lang: "Thai", lang_code: "tha", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "Tiếng Việt", target_lang: "Vietnamese", lang_code: "vie", output_pattern: "{{name}}.{{lang_code}}.srt" },
  {
    label: "Bahasa Indonesia",
    target_lang: "Indonesian",
    lang_code: "ind",
    output_pattern: "{{name}}.{{lang_code}}.srt",
  },
  { label: "Nederlands", target_lang: "Dutch", lang_code: "nld", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "Polski", target_lang: "Polish", lang_code: "pol", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "Türkçe", target_lang: "Turkish", lang_code: "tur", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "हिन्दी", target_lang: "Hindi", lang_code: "hin", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "Українська", target_lang: "Ukrainian", lang_code: "ukr", output_pattern: "{{name}}.{{lang_code}}.srt" },
  { label: "Svenska", target_lang: "Swedish", lang_code: "swe", output_pattern: "{{name}}.{{lang_code}}.srt" },
] as const;

export const DEFAULT_PROMPT = `// You are a professional subtitle translator.
// You will receive subtitle text in an automatically detected source language.
// Translate all subtitles into {{lang}}.
// Note: {{additional}}
// Do not merge sentences, translate them individually.
// Return the translated subtitles in the same order and length as the input.
// 1. Detect the input subtitle language
// 2. Translate the input subtitles into {{lang}}
// 3. Convert names into {{lang}}
// 4. Paraphrase the translated subtitles into more fluent sentences
// 5. Use the setResult method to output the translated subtitles as string[]`;
