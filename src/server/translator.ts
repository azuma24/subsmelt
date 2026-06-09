import fs from "node:fs";
import path from "node:path";
import { parseSync, stringifySync } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";
import { z } from "zod";
import { generateText, tool, type ReasoningOutput } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

function getAi({ apiKey, apiHost }: { apiKey: string; apiHost: string }) {
  return createOpenAICompatible({
    name: "openai",
    apiKey: apiKey || "sk-dummy",
    baseURL: apiHost,
  });
}



/** Extract plain text from AI SDK reasoning output (may be string or ReasoningOutput[]). */
function extractReasoningText(reasoning: string | ReasoningOutput[] | undefined): string {
  if (!reasoning) return "";
  if (typeof reasoning === "string") return reasoning;
  return reasoning.map((r) => ("text" in r ? r.text : "")).join("");
}

function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonFromText(value: string): unknown {
  const direct = tryJsonParse(value);
  if (direct != null) return direct;

  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsedFence = tryJsonParse(fenced[1].trim());
    if (parsedFence != null) return parsedFence;
  }

  const startObj = value.indexOf("{");
  const endObj = value.lastIndexOf("}");
  if (startObj >= 0 && endObj > startObj) {
    const maybeObj = value.slice(startObj, endObj + 1);
    const parsedObj = tryJsonParse(maybeObj);
    if (parsedObj != null) return parsedObj;
  }

  const startArr = value.indexOf("[");
  const endArr = value.lastIndexOf("]");
  if (startArr >= 0 && endArr > startArr) {
    const maybeArr = value.slice(startArr, endArr + 1);
    const parsedArr = tryJsonParse(maybeArr);
    if (parsedArr != null) return parsedArr;
  }

  return null;
}

function stripMarkdownFences(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function coerceTranslatedArray(parsed: unknown): string[] | null {
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const candidates = [obj.translated, obj.result, obj.results, obj.translations];
    for (const value of candidates) {
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return value as string[];
      }
    }
  }
  return null;
}

function coerceSingleTranslation(parsed: unknown, rawText: string): string | null {
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const candidates = [obj.result, obj.translated, obj.translation, obj.text];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  const cleaned = stripMarkdownFences(rawText);
  if (!cleaned) return null;

  const quoted = cleaned.match(/^"([\s\S]*)"$/);
  if (quoted?.[1]) return quoted[1].trim();

  // If cleaned text is very long it's a reasoning trace, not a translation.
  // Return null so the caller falls through to the plain-text generateText fallback.
  if (cleaned.length > 400) return null;

  return cleaned;
}

/**
 * Extract the final translation answer from a reasoning/thinking trace.
 * Reasoning models write long chain-of-thought before settling on a final answer.
 * We look for the last clean quoted string (「...」 or "...") or the last
 * non-meta line (not starting with *, -, Let, Wait, Note, Option, #).
 * Returns null if no clean answer is found (caller falls through to text fallback).
 */
function extractFinalAnswerFromReasoning(reasoning: string): string | null {
  if (!reasoning || reasoning.length < 2) return null;

  // Try last 「...」 or "..." quoted block
  const quotedMatches = [...reasoning.matchAll(/[「"]([^「」""]{1,300})[」"]/g)];
  if (quotedMatches.length > 0) {
    const last = quotedMatches[quotedMatches.length - 1][1].trim();
    if (last && last.length >= 1 && last.length <= 300) return last;
  }

  // Try last non-meta line that looks like a translation (contains CJK or is short)
  const lines = reasoning.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Skip meta lines
    if (/^[\*\-#>]/.test(line)) continue;
    if (/^(let'?s|wait|note:|option \d|actually|final|refin|translat|source|input|context|glossary|target)/i.test(line)) continue;
    // Must be reasonably short (subtitle line)
    if (line.length > 300 || line.length < 1) continue;
    return line;
  }

  return null;
}

/**
 * Extract translations from Gemma-style numbered reasoning output.
 * Gemma writes: 1. "source" -> 翻譯  or  1.  翻譯
 * Returns array in order, or null if pattern not found.
 */
function extractNumberedTranslations(text: string, expectedCount: number): string[] | null {
  // Match patterns like: 1. "..." -> 翻譯  or  1. 翻譯  or  1.  翻譯
  const lines = text.split("\n");
  const results: Map<number, string> = new Map();

  for (const line of lines) {
    // Pattern: N. "source" -> translation   OR   N. translation
    const arrowMatch = line.match(/^\s*(\d+)\.\s+(?:"[^"]*"\s*->\s*)(.+)$/);
    if (arrowMatch) {
      const idx = parseInt(arrowMatch[1], 10);
      const val = arrowMatch[2].replace(/^\s*["「]|["」]\s*$/g, "").trim();
      if (val) results.set(idx, val);
      continue;
    }
    // Pattern: N. translation (no arrow, no source quoted)
    const simpleMatch = line.match(/^\s*(\d+)\.\s+([^"*\-].+)$/);
    if (simpleMatch) {
      const idx = parseInt(simpleMatch[1], 10);
      const val = simpleMatch[2].replace(/^\s*["「]|["」]\s*$/g, "").trim();
      // Skip meta lines
      if (val && !/^(Note:|Wait,|Looking|Actually|However|Correct|Let'?s|Refin|Source:|Target:|Input:)/.test(val)) {
        if (!results.has(idx)) results.set(idx, val);
      }
    }
  }

  if (results.size === 0) return null;

  // Build ordered array — use last seen value for each index
  const arr: string[] = [];
  for (let i = 1; i <= Math.max(expectedCount, ...results.keys()); i++) {
    const v = results.get(i);
    if (v !== undefined) arr.push(v);
  }

  // Only return if we got close to the expected count
  if (arr.length >= Math.floor(expectedCount * 0.7)) return arr;
  return null;
}


const REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.TRANSLATION_REQUEST_TIMEOUT_MS || "45000", 10) || 45_000
);

/**
 * Normalise a generateText result so callers never need to check reasoning.
 *
 * Many local models (Gemma 4, Qwen3, DeepSeek-R1, …) route ALL output
 * through reasoning_content and leave `text` empty, regardless of whether
 * tool calls are enabled. This wrapper promotes the reasoning trace to `text`
 * when `text` is absent, so every downstream parser sees one consistent field.
 *
 * The original `reasoning` field is preserved so callers that want the raw
 * trace (e.g. extractFinalAnswerFromReasoning) can still access it.
 */
function normalizeResult<T extends { text?: string; reasoning?: any }>(result: T): T {
  if (!result.text?.trim() && result.reasoning) {
    const reasoningText = extractReasoningText(result.reasoning);
    if (reasoningText?.trim()) {
      return { ...result, text: reasoningText };
    }
  }
  return result;
}


async function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = REQUEST_TIMEOUT_MS,
  externalSignal?: AbortSignal
): Promise<T> {
  // If external signal is already aborted, short-circuit immediately
  if (externalSignal?.aborted) throw new Error("STOP_REQUESTED");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  // Forward external abort into our controller so in-flight LLM calls cancel instantly
  const onExternalAbort = () => controller.abort(externalSignal!.reason);
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    return await run(controller.signal);
  } catch (error: any) {
    // Distinguish stop vs timeout
    if (externalSignal?.aborted) throw new Error("STOP_REQUESTED");
    if (error?.name === "AbortError" || error?.message === "STOP_REQUESTED") {
      throw error?.message === "STOP_REQUESTED"
        ? error
        : new Error(`Request timeout after ${timeoutMs}ms`);
    }
    // Wrap non-object throws (plain strings, numbers) so they always have .message
    if (error !== null && typeof error !== "object") {
      throw new Error(String(error));
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function sanitizeSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***")
    .replace(/("api[_-]?key"\s*:\s*")[^"]+("?)/gi, "$1***$2");
}

function truncate(text: string, max = 600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function toSnippet(value: unknown, max = 600): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return truncate(sanitizeSecrets(value), max);
  try {
    return truncate(sanitizeSecrets(JSON.stringify(value)), max);
  } catch {
    return truncate(String(value), max);
  }
}

export interface TranslationErrorDiagnostics {
  message: string;
  status?: number;
  code?: string;
  causeMessage?: string;
  responseSnippet?: string;
}

export function summarizeTranslationError(error: unknown): TranslationErrorDiagnostics {
  const err = error as any;
  const status: number | undefined =
    typeof err?.status === "number"
      ? err.status
      : typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.response?.status === "number"
      ? err.response.status
      : undefined;

  const code = typeof err?.code === "string" ? err.code : undefined;

  const causeMessage =
    typeof err?.cause?.message === "string"
      ? sanitizeSecrets(err.cause.message)
      : undefined;

  const responseBodyRaw =
    err?.responseBody ?? err?.response?.body ?? err?.body ?? err?.data ?? err?.cause?.responseBody;

  const parsed =
    typeof responseBodyRaw === "string" ? tryJsonParse(responseBodyRaw) ?? responseBodyRaw : responseBodyRaw;
  const responseSnippet = toSnippet(parsed);

  // Build the most informative message possible — AI SDK APICallError often has
  // empty .message when LM Studio returns HTTP errors with empty body or
  // {"error":{"message":""}}. Fall through a chain of richer fields.
  let baseMessage: string;
  if (typeof err?.message === "string" && err.message.trim().length > 0) {
    baseMessage = sanitizeSecrets(err.message.trim());
  } else if (causeMessage && causeMessage.trim().length > 0) {
    baseMessage = `Connection error: ${causeMessage}`;
  } else {
    const bodyMsg = extractErrorMessageFromBody(parsed);
    if (bodyMsg) {
      baseMessage = sanitizeSecrets(bodyMsg);
    } else if (responseBodyRaw) {
      baseMessage = status
        ? `HTTP ${status} error (empty/unparseable response body)`
        : "Empty error response from LLM server";
    } else if (status) {
      baseMessage = `HTTP ${status} error from LLM server (no body)`;
    } else if (typeof err?.name === "string" && err.name !== "Error") {
      baseMessage = `LLM error: ${err.name}`;
    } else if (typeof error === "string" && (error as string).trim()) {
      baseMessage = sanitizeSecrets((error as string).trim());
    } else {
      baseMessage = "Unknown translation error";
    }
  }

  const parts = [
    status ? `HTTP ${status}` : null,
    code ? `code=${code}` : null,
    baseMessage,
  ].filter(Boolean);

  return {
    message: parts.join(" | "),
    status,
    code,
    causeMessage,
    responseSnippet,
  };
}

/** Extract a human-readable message from a parsed API error body. */
function extractErrorMessageFromBody(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") {
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim().slice(0, 300);
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  // OpenAI-style: { error: { message: "..." } }
  if (obj.error && typeof obj.error === "object") {
    const errObj = obj.error as Record<string, unknown>;
    if (typeof errObj.message === "string" && errObj.message.trim())
      return errObj.message.trim().slice(0, 300);
    if (typeof errObj.type === "string" && errObj.type.trim())
      return `error type: ${errObj.type.trim()}`;
  }
  // Flat: { message: "..." }
  if (typeof obj.message === "string" && obj.message.trim())
    return obj.message.trim().slice(0, 300);
  // FastAPI-style: { detail: "..." }
  if (typeof obj.detail === "string" && obj.detail.trim())
    return obj.detail.trim().slice(0, 300);
  return null;
}

export function splitIntoChunks(array: any[], by = 20) {
  const chunks: any[][] = [];
  let chunk: any[] = [];
  for (const item of array) {
    if (item.data?.translatedText) continue;
    chunk.push(item);
    if (chunk.length === by) {
      chunks.push(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

async function translateChunk(
  subtitles: string[],
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    systemPrompt: string;
    temperature: number;
    abortSignal?: AbortSignal;
    disableToolCalls?: boolean;
  }
): Promise<string[]> {
  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost });

  let toolResult: string[] | null = null;

  if (!opts.disableToolCalls) {
    const tools = {
      submit_translation: tool({
        description:
          "Provide the final translated subtitles. Keep order and length identical to input.",
        inputSchema: z
          .object({
            translated: z.array(
              z.string().describe("Translated subtitle at the same index")
            ),
          })
          .strict(),
        execute: async ({ translated }) => {
          toolResult = translated;
          return JSON.stringify(translated);
        },
      }),
    } as const;

    try {
      const result = normalizeResult(await withAbortTimeout((abortSignal) =>
        generateText({
          model: ai(opts.model),
          temperature: opts.temperature,
          tools,
          toolChoice: "required",
          system:
            opts.systemPrompt +
            "\nReturn ONLY using the tool, do not include any extra text.",
          prompt:
            "Translate the following subtitles. Return the result via the tool as an array of strings with the exact same length and order as input.\n\n" +
            JSON.stringify(subtitles),
          maxRetries: 0,
          abortSignal,
        }),
        REQUEST_TIMEOUT_MS,
        opts.abortSignal
      ));

      if (toolResult && Array.isArray(toolResult)) return toolResult;

      // normalizeResult promoted reasoning→text; try to parse it as an array
      const fromText = coerceTranslatedArray(extractJsonFromText(result.text || ""));
      if (fromText) return fromText;
      const fromNumbered = extractNumberedTranslations(result.text || "", subtitles.length);
      if (fromNumbered) return fromNumbered;
    } catch (e: any) {
      if (e?.message === "STOP_REQUESTED") throw e;
      // fall through to plain-text path
    }
  }

  const textResult = normalizeResult(await withAbortTimeout((abortSignal) =>
    generateText({
      model: ai(opts.model),
      temperature: opts.temperature,
      system:
        opts.systemPrompt +
        "\nReturn only JSON array of strings. No markdown, no prose.",
      prompt:
        "Translate the following subtitles. Return ONLY a JSON array of translated strings with the exact same length and order as input.\n\n" +
        JSON.stringify(subtitles),
      maxRetries: 0,
      abortSignal,
    }),
    REQUEST_TIMEOUT_MS,
    opts.abortSignal
  ));

  const parsed = extractJsonFromText(textResult.text || "");
  const translated = coerceTranslatedArray(parsed);
  if (translated) return translated;

  // Text may be a reasoning trace — try numbered list extraction
  const fromNumbered = extractNumberedTranslations(textResult.text || "", subtitles.length);
  if (fromNumbered) return fromNumbered;

  throw new Error("Model did not return a valid translated array payload");
}

async function translateSingle(
  subtitle: string,
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    systemPrompt: string;
    temperature: number;
    abortSignal?: AbortSignal;
    disableToolCalls?: boolean;
  }
): Promise<string> {
  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost });

  let toolResult: string | null = null;

  if (!opts.disableToolCalls) {
    const tools = {
      submit_single_translation: tool({
        description: "Provide the final translated text only.",
        inputSchema: z.object({ result: z.string() }).strict(),
        execute: async ({ result }) => {
          toolResult = result;
          return result;
        },
      }),
    } as const;

    try {
      const result = normalizeResult(await withAbortTimeout((abortSignal) =>
        generateText({
          model: ai(opts.model),
          temperature: opts.temperature,
          tools,
          toolChoice: "required",
          system:
            opts.systemPrompt +
            "\nReturn ONLY using the tool, do not include any extra text.",
          prompt:
            "Translate the following subtitle. Return the result via the tool as plain text only.\n\n" +
            JSON.stringify(subtitle),
          maxRetries: 0,
          abortSignal,
        }),
        REQUEST_TIMEOUT_MS,
        opts.abortSignal
      ));

      if (typeof toolResult === "string") return toolResult;

      // normalizeResult promoted reasoning→text; extract best answer
      const text = result.text || "";
      if (text) {
        const final = extractFinalAnswerFromReasoning(text);
        if (final) return final;
        const single = coerceSingleTranslation(extractJsonFromText(text), text);
        if (single) return single;
      }
    } catch (e: any) {
      if (e?.message === "STOP_REQUESTED") throw e;
      // fall through to plain-text path
    }
  }

  const textResult = normalizeResult(await withAbortTimeout((abortSignal) =>
    generateText({
      model: ai(opts.model),
      temperature: opts.temperature,
      system:
        opts.systemPrompt +
        "\nReturn plain translated text only. No explanations, no markdown.",
      prompt:
        "Translate the following subtitle line and return only the translated text.\n\n" +
        JSON.stringify(subtitle),
      maxRetries: 0,
      abortSignal,
    }),
    REQUEST_TIMEOUT_MS,
    opts.abortSignal
  ));

  const rawText = textResult.text || "";
  const final = extractFinalAnswerFromReasoning(rawText);
  if (final) return final;
  const single = coerceSingleTranslation(extractJsonFromText(rawText), rawText);
  if (single) return single;

  throw new Error("Model returned empty single-line translation text");
}

async function analyzeSubtitlesForContext(
  subtitles: string[],
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
    abortSignal?: AbortSignal;
  }
): Promise<string> {
  if (!opts.model || subtitles.length === 0) return "";

  // Cap context analysis to ~800 lines sampled evenly across the file.
  // Sending all 5000+ lines of a feature film would blow past any model's
  // context window and silently return "". We take an evenly-spaced sample
  // so early, mid, and late content is all represented.
  const MAX_ANALYSIS_LINES = 800;
  let sample = subtitles;
  if (subtitles.length > MAX_ANALYSIS_LINES) {
    const step = subtitles.length / MAX_ANALYSIS_LINES;
    sample = Array.from({ length: MAX_ANALYSIS_LINES }, (_, i) =>
      subtitles[Math.min(Math.round(i * step), subtitles.length - 1)]
    );
  }

  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost });
  const temperature = opts.temperature ?? 0.3;

  try {
    const result = normalizeResult(await withAbortTimeout((abortSignal) =>
      generateText({
        model: ai(opts.model),
        temperature,
        system: `# System Prompt

You are a subtitle content analyst assisting a translation and glossary extraction system.

## Task
Analyze subtitle samples and return two outputs:
1. **Plot Summary**
   - Language: ${opts.lang}
   - Length: 5–10 sentences
   - Must be clear, coherent, and written in natural ${opts.lang}
   - Avoid literal stitching of subtitles

2. **Glossary**
   - Up to 50 items
   - Include rare words, character names, places, organizations, fictional elements, or jargon
   - Each entry should include:
     - term (required)
     - description (required)
     - category (optional: person, place, organization, jargon, fictional, other)
     - preferredTranslation (optional)
     - notes (optional)

## Output format
Use exactly this markdown structure:
### 📝 Plot Summary
<summary text>

### 📚 Glossary
- term: ... | description: ... | category: ... | preferredTranslation: ... | notes: ...`,
        prompt:
          `Produce plot summary in ${opts.lang} and glossary from this subtitle sample:\n` +
          sample.join("\n"),
        maxRetries: 0,
        abortSignal,
      }),
      REQUEST_TIMEOUT_MS,
      opts.abortSignal
    ));

    return result.text?.trim() || "";
  } catch (e: any) {
    if (e?.message === "STOP_REQUESTED") throw e;
    return "";
  }
}

export function parseSubtitle(fileContent: string, fileExtension: string) {
  if (["srt", "vtt"].includes(fileExtension)) {
    return parseSync(fileContent);
  }
  if (["ass", "ssa"].includes(fileExtension)) {
    const parsedAss = assParser(fileContent);
    const events = parsedAss
      .filter((x: any) => x.section === "Events")[0]
      .body.filter(({ key }: any) => key === "Dialogue")
      .map((line: any) => ({
        type: "cue",
        data: {
          text: line.value.Text,
          start: line.value.Start,
          end: line.value.End,
        },
      }));
    return { full: parsedAss, events };
  }
  throw new Error(`Unsupported extension: ${fileExtension}`);
}

type CueLike = {
  type?: string;
  data?: {
    text?: string;
    translatedText?: string;
    start?: number | string;
    end?: number | string;
  };
};

function parseAssTimestampToMs(value: string): number {
  const m = value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const sec = Number(m[3] || 0);
  const frac = m[4] || "0";
  const ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac.slice(0, 3));
  return (((h * 60 + min) * 60) + sec) * 1000 + ms;
}

function normalizeTimeToMs(value: number | string | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (/^\d{2}:\d{2}:\d{2}[,.]\d{3}$/.test(trimmed)) {
    const normalized = trimmed.replace(",", ".");
    const [hh, mm, ssMs] = normalized.split(":");
    const [ss, ms] = ssMs.split(".");
    return (((Number(hh) * 60 + Number(mm)) * 60) + Number(ss)) * 1000 + Number(ms);
  }
  return parseAssTimestampToMs(trimmed);
}

function toAssTimestamp(value: number | string | undefined): string {
  if (typeof value === "string" && /^\d+:\d{1,2}:\d{1,2}[.,]\d{1,3}$/.test(value.trim())) {
    const normalized = value.trim().replace(",", ".");
    const [h, m, secFrac] = normalized.split(":");
    const [sec, frac = "0"] = secFrac.split(".");
    const centis = (frac + "00").slice(0, 2);
    return `${Number(h)}:${m.padStart(2, "0")}:${sec.padStart(2, "0")}.${centis}`;
  }

  const ms = Math.max(0, normalizeTimeToMs(value));
  const totalCentis = Math.floor(ms / 10);
  const centis = totalCentis % 100;
  const totalSeconds = Math.floor(totalCentis / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function buildAssDocumentFromCues(cues: CueLike[]): any[] {
  const dialogues = cues.map((cue) => ({
    key: "Dialogue",
    value: {
      Layer: "0",
      Start: toAssTimestamp(cue?.data?.start),
      End: toAssTimestamp(cue?.data?.end),
      Style: "Default",
      Name: "",
      MarginL: "0",
      MarginR: "0",
      MarginV: "0",
      Effect: "",
      Text: String(cue?.data?.translatedText || cue?.data?.text || "").replace(/\r?\n/g, "\\N"),
    },
  }));

  return [
    {
      section: "Script Info",
      body: [
        { key: "Title", value: "SubSmelt Translation" },
        { key: "ScriptType", value: "v4.00+" },
        { key: "Collisions", value: "Normal" },
        { key: "PlayResX", value: "1920" },
        { key: "PlayResY", value: "1080" },
        { key: "WrapStyle", value: "0" },
      ],
    },
    {
      section: "V4+ Styles",
      body: [
        {
          key: "Format",
          value: [
            "Name",
            "Fontname",
            "Fontsize",
            "PrimaryColour",
            "SecondaryColour",
            "OutlineColour",
            "BackColour",
            "Bold",
            "Italic",
            "Underline",
            "StrikeOut",
            "ScaleX",
            "ScaleY",
            "Spacing",
            "Angle",
            "BorderStyle",
            "Outline",
            "Shadow",
            "Alignment",
            "MarginL",
            "MarginR",
            "MarginV",
            "Encoding",
          ],
        },
        {
          key: "Style",
          value: {
            Name: "Default",
            Fontname: "Arial",
            Fontsize: "48",
            PrimaryColour: "&H00FFFFFF",
            SecondaryColour: "&H000000FF",
            OutlineColour: "&H00000000",
            BackColour: "&H64000000",
            Bold: "0",
            Italic: "0",
            Underline: "0",
            StrikeOut: "0",
            ScaleX: "100",
            ScaleY: "100",
            Spacing: "0",
            Angle: "0",
            BorderStyle: "1",
            Outline: "2",
            Shadow: "0",
            Alignment: "2",
            MarginL: "20",
            MarginR: "20",
            MarginV: "20",
            Encoding: "1",
          },
        },
      ],
    },
    {
      section: "Events",
      body: [
        {
          key: "Format",
          value: [
            "Layer",
            "Start",
            "End",
            "Style",
            "Name",
            "MarginL",
            "MarginR",
            "MarginV",
            "Effect",
            "Text",
          ],
        },
        ...dialogues,
      ],
    },
  ];
}

export function saveTranslated(
  outputPath: string,
  parsedSubtitle: any,
  outputExtension: string,
  cues: CueLike[]
) {
  let newSubtitle: string;
  const ext = outputExtension.toLowerCase();

  if (["srt", "vtt"].includes(ext)) {
    const format = ext === "vtt" ? "WebVTT" : "SRT";
    newSubtitle = stringifySync(
      cues.map((x: CueLike) => ({
        type: "cue",
        data: {
          ...x.data,
          start: normalizeTimeToMs(x?.data?.start),
          end: normalizeTimeToMs(x?.data?.end),
          text: x?.data?.translatedText || x?.data?.text || "",
        },
      })),
      { format }
    );
  } else if (["ass", "ssa"].includes(ext)) {
    const hasAssStructure =
      parsedSubtitle &&
      typeof parsedSubtitle === "object" &&
      !Array.isArray(parsedSubtitle) &&
      Array.isArray(parsedSubtitle.full);

    if (hasAssStructure) {
      let dialogueIndex = 0;
      newSubtitle = assStringify(
        parsedSubtitle.full.map((section: any) => {
          if (section.section !== "Events" || !Array.isArray(section.body)) return section;
          return {
            ...section,
            body: section.body.map((line: any) => {
              if (line.key !== "Dialogue") return line;
              const cue = cues[dialogueIndex++];
              const translatedText = cue?.data?.translatedText || cue?.data?.text || line.value?.Text || "";
              return {
                key: "Dialogue",
                value: { ...line.value, Text: translatedText },
              };
            }),
          };
        })
      );
    } else {
      newSubtitle = assStringify(buildAssDocumentFromCues(cues));
    }
  } else {
    throw new Error(`Unsupported extension: ${ext}`);
  }

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Atomic write
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, newSubtitle, "utf8");
  try {
    fs.renameSync(tmpPath, outputPath);
  } catch {
    fs.writeFileSync(outputPath, newSubtitle, "utf8");
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }

  // Make the output world-writable so other hosts on the NAS share can edit it.
  // Best-effort: SMB/NFS mounts with no_acl may reject chmod, which is fine.
  try {
    fs.chmodSync(outputPath, 0o666);
  } catch {}
}

async function retryTranslate<T>(
  fn: (attempt: number) => Promise<T>,
  maxRetries = 5,
  delay = 1000,
  onRetry?: (attempt: number, error: any, backoff: number) => void
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error: any) {
      if (attempt === maxRetries) throw error;
      const msg = (error?.message || "").toLowerCase();
      // Never retry a stop request — propagate immediately
      if (msg === "stop_requested") throw error;
      const isRetryable =
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("rate limit") ||
        msg.includes("no object generated") ||
        msg.includes("did not match schema") ||
        msg.includes("validation") ||
        msg.includes("empty single-line translation") ||
        error?.status >= 429;
      if (!isRetryable) throw error;
      const backoff =
        delay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
      onRetry?.(attempt, error, backoff);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error("Unreachable");
}

export interface TranslateFileOptions {
  srtPath: string;
  outputPath: string;
  apiKey: string;
  apiHost: string;
  model: string;
  prompt: string;
  lang: string;
  sourceLang?: string;
  additional: string;
  temperature: number;
  chunkSize: number;
  contextSize: number;
  parallelChunks: number;
  onProgress?: (completed: number, total: number) => void;
  onRetry?: (attempt: number, error: any, backoff: number) => void;
  onAnalysis?: (analysis: string) => void;
  abortSignal?: AbortSignal;
  disableToolCalls?: boolean;
}

export function isAutomaticSourceLanguage(sourceLang?: string): boolean {
  const normalized = (sourceLang || "").trim().toLowerCase();
  return !normalized || normalized === "automatic" || normalized === "auto" || normalized === "auto-detect" || normalized === "detect";
}

export function buildTranslationSystemPrompt(opts: { prompt: string; lang: string; sourceLang?: string; additional: string }): string {
  const sourceInstruction = isAutomaticSourceLanguage(opts.sourceLang)
    ? "Source subtitle language: detect automatically from the input cues. Translate every subtitle into the target language."
    : `Source subtitle language: ${opts.sourceLang}. Translate every subtitle into the target language.`;

  const renderedPrompt = opts.prompt
    .replaceAll("{{source_lang}}", isAutomaticSourceLanguage(opts.sourceLang) ? "automatically detected" : opts.sourceLang || "automatically detected")
    .replaceAll("{{lang}}", opts.lang)
    .replaceAll("{{additional}}", opts.additional);

  return `${sourceInstruction}\n\n${renderedPrompt}`;
}

export async function translateFile(opts: TranslateFileOptions): Promise<void> {
  const sourceExt = path.extname(opts.srtPath).slice(1).toLowerCase();
  const outputExt = path.extname(opts.outputPath).slice(1).toLowerCase() || sourceExt;
  const content = fs.readFileSync(opts.srtPath, "utf8");
  const parsed = parseSubtitle(content, sourceExt);

  let subtitle: any[];
  if (Array.isArray(parsed)) {
    subtitle = parsed.filter((line: any) => line.type === "cue");
  } else if ((parsed as any).events) {
    subtitle = (parsed as any).events;
  } else {
    subtitle = parsed as any;
  }

  const totalCues = subtitle.length;
  if (totalCues === 0) throw new Error("No subtitle cues found");

  opts.onProgress?.(0, totalCues);

  const allTexts = subtitle
    .map((cue: any) => (cue?.data ? String(cue.data.text || "") : ""))
    .map((text: string) => text.replace(/\n/g, " ").trim())
    .filter((text: string) => text.length > 0);

  let effectiveAdditional = opts.additional;
  const analysis = await analyzeSubtitlesForContext(allTexts, {
    apiKey: opts.apiKey,
    apiHost: opts.apiHost,
    model: opts.model,
    lang: opts.lang,
    temperature: 0.3,
    abortSignal: opts.abortSignal,
  });

  if (analysis) {
    effectiveAdditional = `${effectiveAdditional ? `${effectiveAdditional}\n\n` : ""}[Context]\n${analysis}`;
    opts.onAnalysis?.(analysis);
  }

  const systemPrompt = buildTranslationSystemPrompt({
    prompt: opts.prompt,
    lang: opts.lang,
    sourceLang: opts.sourceLang,
    additional: effectiveAdditional,
  });

  const indexMap = new Map<any, number>();
  subtitle.forEach((cue, idx) => indexMap.set(cue, idx));

  const chunks = splitIntoChunks(subtitle, opts.chunkSize);
  let completedCues = 0;
  const contextSize = opts.contextSize;
  const concurrency = Math.max(1, Math.min(8, opts.parallelChunks || 1));

  // Concurrency-limited chunk processor.
  // Each slot processes chunks from the shared queue independently.
  // Progress and partial saves are guarded by a simple mutex flag.
  const chunkQueue = [...chunks];
  // Promise-chain mutex: each save is serialized by chaining onto the previous one.
  // Using a flag is NOT safe — two workers can both read `saving === false` before
  // either sets it to true (both pass the check in the same microtask tick).
  let saveChain = Promise.resolve();

  async function processChunk(block: any[]) {
    const coreIndices = block
      .map((cue: any) => indexMap.get(cue) as number)
      .filter((n: number) => typeof n === "number")
      .sort((a: number, b: number) => a - b);

    if (coreIndices.length === 0) return;

    const coreStart = coreIndices[0];
    const coreEnd = coreIndices[coreIndices.length - 1];
    const contextStart = Math.max(0, coreStart - contextSize);
    const contextEnd = Math.min(subtitle.length - 1, coreEnd + contextSize);

    const windowCues = subtitle.slice(contextStart, contextEnd + 1);
    const windowText = windowCues.map((c: any) =>
      c?.data ? String(c.data.text).replace(/\n/g, " ").trim() : ""
    );

    let translatedWindow: string[] | null = null;

    // Single retryTranslate call with 4 attempts, varying temperature each time.
    // The old pattern (3 outer × 5 inner retries) could make up to 15 LLM calls
    // per chunk — exponential backoff on top means a stuck chunk blocks a worker
    // for 10+ minutes. 4 flat attempts is enough to handle transient failures.
    try {
      translatedWindow = await retryTranslate(
        (attempt) => {
          const attemptTemp = Math.max(
            0.1,
            Math.min(2, opts.temperature + (attempt - 1) * 0.15 + (Math.random() - 0.5) * 0.1)
          );
          return translateChunk(windowText, {
            apiKey: opts.apiKey,
            apiHost: opts.apiHost,
            model: opts.model,
            systemPrompt,
            temperature: attemptTemp,
            abortSignal: opts.abortSignal,
            disableToolCalls: opts.disableToolCalls,
          }).then((result) => {
            if (!Array.isArray(result) || result.length !== windowText.length) {
              throw new Error("did not match schema");
            }
            return result;
          });
        },
        4,
        1000,
        opts.onRetry
      );
    } catch (e: any) {
      if (e?.message === "STOP_REQUESTED") throw e;
      translatedWindow = null;
    }

    // Single-line fallback
    if (!translatedWindow) {
      translatedWindow = new Array(windowText.length).fill(null);
      for (const idx of coreIndices) {
        const lineText = subtitle[idx]?.data?.text || "";
        const single = await retryTranslate(
          (_) =>
            translateSingle(lineText, {
              apiKey: opts.apiKey,
              apiHost: opts.apiHost,
              model: opts.model,
              systemPrompt,
              temperature: opts.temperature,
              abortSignal: opts.abortSignal,
              disableToolCalls: opts.disableToolCalls,
            }),
          5,
          1000,
          opts.onRetry
        );
        translatedWindow![idx - contextStart] = single;
      }
    }

    // Write translations back (safe: each block owns distinct cues)
    let chunkCompleted = 0;
    for (const cue of block) {
      const idx = indexMap.get(cue) as number;
      if (typeof idx !== "number") continue;
      const offset = idx - contextStart;
      const t = translatedWindow?.[offset];
      if (cue?.data && typeof t === "string") {
        cue.data.translatedText = t;
        chunkCompleted++;
      }
    }

    completedCues += chunkCompleted;
    opts.onProgress?.(completedCues, totalCues);

    // Partial save — serialize via promise chain to prevent concurrent file writes.
    // Each processChunk call appends to the chain; writes never interleave.
    saveChain = saveChain.then(() => {
      try {
        saveTranslated(opts.outputPath, parsed, outputExt, subtitle);
      } catch {}
    });
  }

  // Worker: drain the shared chunk queue
  async function worker() {
    while (chunkQueue.length > 0) {
      const block = chunkQueue.shift();
      if (!block) break;
      await processChunk(block);
    }
  }

  // Launch `concurrency` workers in parallel
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Fallback for untranslated
  const untranslated = subtitle.filter((l: any) => !l.data?.translatedText);
  for (const cue of untranslated) {
    if (cue?.data) {
      cue.data.translatedText = await retryTranslate(
        (_) =>
          translateSingle(cue.data.text, {
            apiKey: opts.apiKey,
            apiHost: opts.apiHost,
            model: opts.model,
            systemPrompt,
            temperature: opts.temperature,
            abortSignal: opts.abortSignal,
            disableToolCalls: opts.disableToolCalls,
          }),
        5,
        1000,
        opts.onRetry
      );
      completedCues++;
      opts.onProgress?.(completedCues, totalCues);
    }
  }

  // Final write
  saveTranslated(opts.outputPath, parsed, outputExt, subtitle);
}

/** Test LLM connection by translating a simple phrase */
export async function testConnection(opts: {
  apiKey: string;
  apiHost: string;
  model: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await translateSingle("Hello, how are you?", {
      ...opts,
      systemPrompt: "Translate to Traditional Chinese (Taiwan).",
      temperature: 0.3,
    });
    return { ok: true, message: `Success: "${result}"` };
  } catch (error: any) {
    return { ok: false, message: error.message || "Connection failed" };
  }
}
