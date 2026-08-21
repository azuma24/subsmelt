// Barrel module. utils.ts used to hold every subtitle/text helper directly;
// the implementations now live in focused sibling modules (encoding.ts,
// convert.ts, cue-edits.ts, text-coercion.ts). This file re-exports the same
// public surface so existing importers — within translator/ and the top-level
// translator.ts barrel — keep working without any change to their import
// paths.

export { readSubtitleFileText } from "./encoding.js";

export {
  parseSubtitle,
  splitIntoChunks,
  convertSubtitle,
  type SubtitleCue,
  type CueLike,
  type ConvertExt,
} from "./convert.js";

export {
  applyCueEdits,
  writeSubtitleFile,
  saveTranslated,
  type CueEdit,
} from "./cue-edits.js";

export {
  sanitizeSecrets,
  truncate,
  toSnippet,
  extractReasoningText,
  tryJsonParse,
  extractJsonFromText,
  stripMarkdownFences,
  coerceTranslatedArray,
  coerceSingleTranslation,
  extractFinalAnswerFromReasoning,
  extractNumberedTranslations,
} from "./text-coercion.js";
