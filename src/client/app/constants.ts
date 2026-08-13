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
 *  `operate` is the live queue surface, `create` holds the tools that produce
 *  new subtitles, and `system` is the configure/diagnose pair (Settings, Logs).
 *  That last group is labelled "System" rather than "Configure" because several
 *  locales translate "Configure" to the same word as the Settings item itself
 *  (es "Configuración", pt "Configurações"), which reads as a duplicate. */
export const NAV_GROUPS = [
  { id: "operate", labelKey: "nav.groupOperate" },
  { id: "create", labelKey: "nav.groupCreate" },
  { id: "system", labelKey: "nav.groupSystem" },
] as const;

export type NavGroupId = (typeof NAV_GROUPS)[number]["id"];

/** `mobile: "primary"` items get a cell in the bottom bar; `"overflow"` items
 *  live behind the "More" sheet (still one tap from the bar, so every
 *  destination stays reachable in two taps). */
export const NAV_ITEMS = [
  { path: "/", labelKey: "nav.dashboard", icon: "📊", group: "operate", mobile: "primary" },
  { path: "/translations", labelKey: "nav.translations", icon: "🌐", group: "create", mobile: "primary" },
  { path: "/whisper", labelKey: "nav.whisper", icon: "🎙️", group: "create", mobile: "primary" },
  { path: "/convert", labelKey: "nav.convert", icon: "🔄", group: "create", mobile: "overflow" },
  { path: "/settings", labelKey: "nav.settings", icon: "⚙️", group: "system", mobile: "primary" },
  { path: "/logs", labelKey: "nav.logs", icon: "📋", group: "system", mobile: "overflow" },
] as const;

export type NavItem = (typeof NAV_ITEMS)[number];

export const navItemsInGroup = (group: NavGroupId): readonly NavItem[] =>
  NAV_ITEMS.filter((item) => item.group === group);

export const MOBILE_PRIMARY_NAV: readonly NavItem[] = NAV_ITEMS.filter((item) => item.mobile === "primary");
export const MOBILE_OVERFLOW_NAV: readonly NavItem[] = NAV_ITEMS.filter((item) => item.mobile === "overflow");

export const STATUS_ICON: Record<string, string> = {
  done: "✓",
  pending: "○",
  translating: "◉",
  error: "✕",
  // "Skipped" is actionable, not inert: it means the file was never translated
  // (an existing target subtitle was found). The glyph has to read differently
  // from `pending`'s ○ and `done`'s ✓ so the badge is not mistaken for either.
  skipped: "⊘",
  new: "+",
};

export const STATUS_LABEL_KEY: Record<string, string> = {
  done: "dashboard.status.done",
  pending: "dashboard.status.pending",
  translating: "dashboard.status.translating",
  error: "dashboard.status.error",
  skipped: "dashboard.status.skipped",
  new: "dashboard.status.new",
};

export const PRESETS = [
  { label: "English", target_lang: "English", lang_code: "eng", output_pattern: "{{name}}.eng.srt" },
  { label: "繁體中文", target_lang: "Traditional Chinese (Taiwan)", lang_code: "chi", output_pattern: "{{name}}.chi.srt" },
  { label: "日本語", target_lang: "Japanese", lang_code: "jpn", output_pattern: "{{name}}.jpn.srt" },
  { label: "한국어", target_lang: "Korean", lang_code: "kor", output_pattern: "{{name}}.kor.srt" },
  { label: "Español", target_lang: "Spanish", lang_code: "spa", output_pattern: "{{name}}.spa.srt" },
  { label: "Français", target_lang: "French", lang_code: "fra", output_pattern: "{{name}}.fra.srt" },
  { label: "Deutsch", target_lang: "German", lang_code: "deu", output_pattern: "{{name}}.deu.srt" },
  { label: "Português", target_lang: "Portuguese", lang_code: "por", output_pattern: "{{name}}.por.srt" },
  { label: "简体中文", target_lang: "Simplified Chinese", lang_code: "chs", output_pattern: "{{name}}.chs.srt" },
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
