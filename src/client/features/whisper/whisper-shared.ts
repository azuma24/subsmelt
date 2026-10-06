// Small constants, types and helpers shared across the Whisper feature's
// split-out sections (RunOptionsSection, UrlTranscribeSection, LibraryPicker)
// and WhisperPage itself.

import type { ModelEngine, ModelSupports, WhisperModelDescriptor } from "../../types";

export const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

export type OutputFormat = "srt" | "ass" | "vtt" | "txt";
export const FORMATS: OutputFormat[] = ["srt", "ass", "vtt", "txt"];
export const FALLBACK_MODELS = ["tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3", "distil-large-v3", "large-v3-turbo"];

// Labels for the Whisper sizes, richer and translated; other models show the
// backend's label.
export const MODEL_LABEL_KEYS: Record<string, string> = {
  tiny: "settings.transcription.modelTiny",
  base: "settings.transcription.modelBase",
  small: "settings.transcription.modelSmall",
  medium: "settings.transcription.modelMedium",
  "large-v1": "settings.transcription.modelLargeV1",
  "large-v2": "settings.transcription.modelLargeV2",
  "large-v3": "settings.transcription.modelLargeV3",
  "distil-large-v3": "settings.transcription.modelDistilLargeV3",
  "large-v3-turbo": "settings.transcription.modelLargeV3Turbo",
};

export const MODEL_ENGINES: ModelEngine[] = ["whisper", "nemotron"];

// Same rule as src/server/transcription/model-engine.ts; the client build
// cannot import server modules.
export const modelEngine = (id: string): ModelEngine => (id.toLowerCase().startsWith("nemotron") ? "nemotron" : "whisper");

const ALL_SUPPORTED: ModelSupports = {
  prompt: true,
  beamSize: true,
  conditionOnPreviousText: true,
  vad: true,
  computeType: true,
  wordTimestamps: true,
  translateTask: true,
};

/** A descriptor for a backend that only reports the model id. */
export function synthesizeDescriptor(id: string): WhisperModelDescriptor {
  return {
    id,
    engine: modelEngine(id),
    label: id,
    languages: "all",
    supports: ALL_SUPPORTED,
    available: true,
    unavailableReason: null,
  };
}

export function descriptorsFrom(capabilities?: { models?: string[]; modelInfo?: WhisperModelDescriptor[] }): WhisperModelDescriptor[] {
  if (capabilities?.modelInfo?.length) return capabilities.modelInfo;
  const ids = capabilities?.models?.length ? capabilities.models : FALLBACK_MODELS;
  return ids.map(synthesizeDescriptor);
}

/** The descriptor for `id`, synthesized when the backend does not list it (e.g. a saved value). */
export function findDescriptor(descriptors: WhisperModelDescriptor[], id: string): WhisperModelDescriptor {
  return descriptors.find((d) => d.id === id) ?? synthesizeDescriptor(id);
}

/** Items grouped by engine in MODEL_ENGINES order; engines with no items are left out. */
export function groupByEngine<T extends { engine: ModelEngine }>(items: T[]): { engine: ModelEngine; items: T[] }[] {
  return MODEL_ENGINES
    .map((engine) => ({ engine, items: items.filter((item) => item.engine === engine) }))
    .filter((group) => group.items.length > 0);
}

export function supportsLanguage(model: WhisperModelDescriptor, language: string): boolean {
  if (language === "auto" || model.languages === "all") return true;
  const wanted = language.toLowerCase();
  return model.languages.some((code) => code.toLowerCase() === wanted);
}

/** True when the model decides some decoding options itself, so the UI hides them. */
export function hidesOptions(model: WhisperModelDescriptor): boolean {
  const { prompt, beamSize, conditionOnPreviousText, vad, computeType } = model.supports;
  return ![prompt, beamSize, conditionOnPreviousText, vad, computeType].every(Boolean);
}

export const COMMON_LANGS = ["auto", "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "ar", "hi"];
// CTranslate2 compute types are device-specific: float16 / int8_float16 are
// GPU-only and crash on CPU. Gate the selector by device so an invalid pair can
// never be chosen (keeps it simple + error-free). int8 is valid everywhere.
export const COMPUTE_BY_DEVICE: Record<string, string[]> = {
  cpu: ["int8", "float32"],
  cuda: ["int8", "int8_float16", "float16", "float32"],
};

// noSpeech: the run found nothing to transcribe (reported with error).
// phase "waiting_for_gpu": held until a translation batch frees the GPU.
export interface FileProgress { pct?: number; done?: boolean; error?: boolean; noSpeech?: boolean; cancelled?: boolean; phase?: string }

export { selectCls } from "../../ui/SortControls";
