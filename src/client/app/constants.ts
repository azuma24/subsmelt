export const LANGUAGES = [
  { code: "en", label: "EN" },
  { code: "zh-TW", label: "繁中" },
  { code: "zh-CN", label: "简中" },
  { code: "ja", label: "日本語" },
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
// You will only receive subtitles and are only required to translate, no need for any replies.
// Note: {{additional}}
// Do not merge sentences, translate them individually.
// Return the translated subtitles in the same order and length as the input.
// 1. Parse the input subtitles
// 2. Translate the input subtitles into {{lang}}
// 3. Convert names into {{lang}}
// 4. Paraphrase the translated subtitles into more fluent sentences
// 5. Use the setResult method to output the translated subtitles as string[]`;
