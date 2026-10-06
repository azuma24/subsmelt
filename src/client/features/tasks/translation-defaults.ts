import type { Task } from "../../types";
import { PRESETS } from "../../app/constants";

export const OUTPUT_FORMATS = ["srt", "vtt", "ass", "ssa"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const AUTO_SOURCE_LANG = "Automatic";
export const DEFAULT_TARGET_LANG = "English";
export const DEFAULT_LANG_CODE = "eng";
export const DEFAULT_OUTPUT_PATTERN = "{{name}}.{{lang_code}}.srt";

export const LANGUAGE_OPTIONS = PRESETS.map((preset) => ({
  value: preset.lang_code,
  label: `${preset.label} · ${preset.lang_code}`,
  targetLang: preset.target_lang,
  outputPattern: preset.output_pattern,
}));

export function getTranslationPresetByLangCode(langCode?: string) {
  return PRESETS.find((preset) => preset.lang_code === langCode);
}

export function applyTranslationPreset(draft: Partial<Task>, langCode: string): Partial<Task> {
  const preset = getTranslationPresetByLangCode(langCode);
  if (!preset) return draft;
  return {
    ...draft,
    source_lang: AUTO_SOURCE_LANG,
    target_lang: preset.target_lang,
    lang_code: preset.lang_code,
    output_pattern: preset.output_pattern,
  };
}

export function inferOutputFormat(pattern?: string): OutputFormat {
  const normalized = (pattern || "").toLowerCase().trim();
  const extMatch = normalized.match(/\.(srt|vtt|ass|ssa)$/);
  if (extMatch) return extMatch[1] as OutputFormat;
  return "srt";
}

export function applyOutputFormat(pattern: string | undefined, format: OutputFormat): string {
  const base = (pattern || DEFAULT_OUTPUT_PATTERN).trim();
  if (!base) return `{{name}}.{{lang_code}}.${format}`;
  if (base.includes("{{ext}}")) return base.split("{{ext}}").join(format);
  if (/\.(srt|vtt|ass|ssa)$/i.test(base)) return base.replace(/\.(srt|vtt|ass|ssa)$/i, `.${format}`);
  return `${base}.${format}`;
}

export function createDefaultTranslationDraft(preset?: typeof PRESETS[number]): Partial<Task> {
  const output_pattern = preset?.output_pattern || DEFAULT_OUTPUT_PATTERN;
  return {
    source_lang: AUTO_SOURCE_LANG,
    target_lang: preset?.target_lang || DEFAULT_TARGET_LANG,
    output_pattern,
    lang_code: preset?.lang_code || DEFAULT_LANG_CODE,
    prompt_override: "",
  };
}
