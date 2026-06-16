// Barrel module for the translator. The implementation lives in focused
// submodules under ./translator/. This file re-exports the public surface so
// existing importers (queue.ts, index.ts, connections.ts, tests) keep working
// without any change to their import paths.

export type { CloudProvider, TokenUsage } from "./translator/ai-client.js";
export {
  extractUsage,
  parseRetryAfter,
  rateLimitRetryDelayMs,
} from "./translator/ai-client.js";

export {
  type ModelContextInfo,
  probeModelContext,
  type TranslationErrorDiagnostics,
  summarizeTranslationError,
  type TranslateFileOptions,
  translateFile,
  testConnection,
} from "./translator/engine.js";

export {
  parseSubtitle,
  readSubtitleFileText,
  saveTranslated,
  splitIntoChunks,
  convertSubtitle,
  type ConvertExt,
} from "./translator/utils.js";

export {
  isAutomaticSourceLanguage,
  buildTranslationSystemPrompt,
} from "./translator/prompt.js";

export {
  type GlossaryEntry,
  parseGlossaryFromAnalysis,
  scanForGlossaryTerms,
  buildChunkGlossaryBlock,
  type SeriesGlossary,
  loadSeriesGlossary,
  mergeSeriesGlossary,
  buildSeriesGlossarySeed,
} from "./translator/context.js";
