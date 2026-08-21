// Small constants, types and helpers shared across the Whisper feature's
// split-out sections (RunOptionsSection, UrlTranscribeSection, LibraryPicker)
// and WhisperPage itself.

export const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

export type OutputFormat = "srt" | "ass" | "vtt" | "txt";
export const FORMATS: OutputFormat[] = ["srt", "ass", "vtt", "txt"];
export const FALLBACK_MODELS = ["tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3", "distil-large-v3", "large-v3-turbo"];
export const COMMON_LANGS = ["auto", "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "ar", "hi"];
// CTranslate2 compute types are device-specific: float16 / int8_float16 are
// GPU-only and crash on CPU. Gate the selector by device so an invalid pair can
// never be chosen (keeps it simple + error-free). int8 is valid everywhere.
export const COMPUTE_BY_DEVICE: Record<string, string[]> = {
  cpu: ["int8", "float32"],
  cuda: ["int8", "int8_float16", "float16", "float32"],
};

export interface FileProgress { pct?: number; done?: boolean; error?: boolean; cancelled?: boolean; phase?: string }

export const selectCls = "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-[12px] text-[var(--text)]";
