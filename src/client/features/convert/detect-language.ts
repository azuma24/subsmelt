import { franc } from "franc-min";
import { findLanguageByFranc } from "./language-table";

const MIN_SAMPLE_CHARS = 10;
const FRANC_UNDETERMINED = "und";
const FRANC_CHINESE = "cmn";

// franc reports "cmn" for all Mandarin text; the script decides the variant.
// These are characters whose simplified and traditional forms differ, so the
// dominant set identifies the script even in short samples.
const SIMPLIFIED_ONLY = "简体对时间发这来学习读写医门问东车马鸟龙语关业乐见觉说话议长风云电";
const TRADITIONAL_ONLY = "簡體對時間發這來學習讀寫醫門問東車馬鳥龍語關業樂見覺說話議長風雲電";

export function detectChineseVariant(text: string): "zh-CN" | "zh-TW" {
  let simplified = 0;
  let traditional = 0;
  for (const ch of text) {
    if (SIMPLIFIED_ONLY.includes(ch)) simplified += 1;
    else if (TRADITIONAL_ONLY.includes(ch)) traditional += 1;
  }
  // Tie (all shared characters) defaults to Simplified — the larger corpus —
  // and the per-file override exists precisely for this case.
  return traditional > simplified ? "zh-TW" : "zh-CN";
}

/**
 * Detect the language of a subtitle text sample. Returns a canonical BCP-47
 * code from the language table, or null when the sample is too short or the
 * detected language is not in the table — callers show "unknown" and let the
 * user override rather than guessing.
 */
export function detectSampleLanguage(sample: string): string | null {
  const text = sample.trim();
  if (text.length < MIN_SAMPLE_CHARS) return null;
  const iso3 = franc(text, { minLength: MIN_SAMPLE_CHARS });
  if (iso3 === FRANC_UNDETERMINED) return null;
  if (iso3 === FRANC_CHINESE) return detectChineseVariant(text);
  return findLanguageByFranc(iso3)?.code ?? null;
}
