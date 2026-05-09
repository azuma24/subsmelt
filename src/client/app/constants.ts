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
] as const;

export const NAV_ITEMS = [
  { path: "/", labelKey: "nav.dashboard", icon: "📊" },
  { path: "/tasks", labelKey: "nav.languages", icon: "🌐" },
  { path: "/settings", labelKey: "nav.settings", icon: "⚙️" },
  { path: "/logs", labelKey: "nav.logs", icon: "📋" },
] as const;

export const STATUS_ICON: Record<string, string> = {
  done: "✓",
  pending: "○",
  translating: "◉",
  error: "✕",
  skipped: "—",
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
