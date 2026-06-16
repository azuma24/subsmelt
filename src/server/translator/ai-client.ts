import { generateText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import {
  coerceSingleTranslation,
  coerceTranslatedArray,
  extractFinalAnswerFromReasoning,
  extractJsonFromText,
  extractNumberedTranslations,
  extractReasoningText,
} from "./utils.js";

export type CloudProvider = "local" | "openai" | "anthropic" | "gemini";

/**
 * Token usage captured from a single generateText call. Normalised across AI SDK
 * versions: v6 exposes `inputTokens`/`outputTokens`, older versions used
 * `promptTokens`/`completionTokens`. We surface the v6 names.
 */
export type TokenUsage = { inputTokens: number; outputTokens: number };

/**
 * Defensively extract a normalised {@link TokenUsage} from a generateText result.
 * Handles both v6 (`inputTokens`/`outputTokens`) and legacy
 * (`promptTokens`/`completionTokens`) shapes, treating missing/undefined fields
 * as 0. Returns null when nothing usable is present.
 */
export function extractUsage(result: unknown): TokenUsage | null {
  const usage = (result as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const inputTokens = num(usage.inputTokens) || num(usage.promptTokens);
  const outputTokens = num(usage.outputTokens) || num(usage.completionTokens);
  if (inputTokens === 0 && outputTokens === 0) return null;
  return { inputTokens, outputTokens };
}

/** Fire an onUsage callback for a generateText result, swallowing extraction failures. */
function reportUsage(result: unknown, onUsage?: (u: TokenUsage) => void): void {
  if (!onUsage) return;
  const usage = extractUsage(result);
  if (usage) onUsage(usage);
}

/**
 * Detect HTTP 429 (rate limit) / 503 (overloaded) from a thrown AI SDK error and,
 * when present, return the wait in ms honoring a `Retry-After` header (delta-seconds
 * or an HTTP-date), capped to `maxMs`. Returns null when the error is not a
 * 429/503 rate-limit-style error.
 *
 * Be defensive: the AI SDK surfaces status under several shapes
 * (`statusCode`, `status`, `response.status`) and headers under
 * `responseHeaders` or `response.headers`.
 */
export function rateLimitRetryDelayMs(error: unknown, maxMs = 60_000, now = Date.now()): number | null {
  const err = error as any;
  const status: number | undefined =
    typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.status === "number"
      ? err.status
      : typeof err?.response?.status === "number"
      ? err.response.status
      : undefined;

  const msg = (err?.message || "").toLowerCase();
  const looksRateLimited =
    status === 429 || status === 503 || msg.includes("rate limit") || msg.includes("too many requests");
  if (!looksRateLimited) return null;

  const headers = err?.responseHeaders ?? err?.response?.headers ?? err?.headers;
  const retryAfter = readHeader(headers, "retry-after");
  const parsed = parseRetryAfter(retryAfter, now);
  if (parsed === null) return 0; // rate-limited but no Retry-After — caller applies its own backoff
  return Math.min(parsed, maxMs);
}

/** Read a header value case-insensitively from a Headers instance or plain object. */
function readHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  // Headers / Map-like with a get() method
  if (typeof (headers as { get?: unknown }).get === "function") {
    const v = (headers as Headers).get(name);
    return v == null ? null : String(v);
  }
  if (typeof headers === "object") {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === lower) return v == null ? null : String(v);
    }
  }
  return null;
}

/**
 * Parse a `Retry-After` header value into a delay in ms. Supports both the
 * delta-seconds form (e.g. "120") and the HTTP-date form (e.g.
 * "Wed, 21 Oct 2015 07:28:00 GMT"). Returns null when the value is absent or
 * unparseable; clamps negatives to 0.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  // delta-seconds
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Number.parseInt(trimmed, 10) * 1000);
  }

  // HTTP-date
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - now);
  }

  return null;
}

export function getAi({ apiKey, apiHost, provider }: { apiKey: string; apiHost: string; provider?: CloudProvider }) {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey: apiKey || "" });
    case "anthropic":
      return createAnthropic({ apiKey: apiKey || "" });
    case "gemini":
      return createGoogleGenerativeAI({ apiKey: apiKey || "" });
    default:
      return createOpenAICompatible({
        name: "openai",
        apiKey: apiKey || "sk-dummy",
        baseURL: apiHost,
      });
  }
}

/** Module-level default — overridden per-job via TranslateFileOptions.requestTimeoutMs */
export const REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.TRANSLATION_REQUEST_TIMEOUT_MS || "300000", 10) || 300_000
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
export function normalizeResult<T extends { text?: string; reasoning?: unknown }>(result: T): T {
  if (!result.text?.trim() && result.reasoning) {
    const reasoningText = extractReasoningText(result.reasoning as Parameters<typeof extractReasoningText>[0]);
    if (reasoningText?.trim()) {
      return { ...result, text: reasoningText };
    }
  }
  return result;
}

export async function withAbortTimeout<T>(
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

export async function retryTranslate<T>(
  fn: (attempt: number) => Promise<T>,
  maxRetries = 5,
  delay = 1000,
  onRetry?: (attempt: number, error: unknown, backoff: number) => void
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
      // Rate-limit aware backoff: when the server says 429/503, honor Retry-After
      // (capped) instead of the default exponential schedule. A 429 with no
      // Retry-After falls back to exponential too.
      const rateLimitMs = rateLimitRetryDelayMs(error);
      const exponential =
        delay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
      const backoff = rateLimitMs && rateLimitMs > 0 ? rateLimitMs : exponential;
      onRetry?.(attempt, error, backoff);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error("Unreachable");
}

export async function translateChunk(
  subtitles: string[],
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    provider?: CloudProvider;
    systemPrompt: string;
    temperature: number;
    abortSignal?: AbortSignal;
    disableToolCalls?: boolean;
    requestTimeoutMs?: number;
    /** Optional read-only context lines prepended to the prompt. */
    contextPromptPrefix?: string;
    /** Fired after each successful generateText with that call's token usage. */
    onUsage?: (u: TokenUsage) => void;
  }
): Promise<string[]> {
  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost, provider: opts.provider });
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const prefix = opts.contextPromptPrefix || "";

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
            `${prefix}Translate the following subtitles. Return the result via the tool as an array of strings with the exact same length and order as input.\n\n` +
            JSON.stringify(subtitles),
          maxRetries: 0,
          abortSignal,
        }),
        timeoutMs,
        opts.abortSignal
      ));
      reportUsage(result, opts.onUsage);

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
        `${prefix}Translate the following subtitles. Return ONLY a JSON array of translated strings with the exact same length and order as input.\n\n` +
        JSON.stringify(subtitles),
      maxRetries: 0,
      abortSignal,
    }),
    timeoutMs,
    opts.abortSignal
  ));
  reportUsage(textResult, opts.onUsage);

  const parsed = extractJsonFromText(textResult.text || "");
  const translated = coerceTranslatedArray(parsed);
  if (translated) return translated;

  // Text may be a reasoning trace — try numbered list extraction
  const fromNumbered = extractNumberedTranslations(textResult.text || "", subtitles.length);
  if (fromNumbered) return fromNumbered;

  throw new Error("Model did not return a valid translated array payload");
}

export async function translateSingle(
  subtitle: string,
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    provider?: CloudProvider;
    systemPrompt: string;
    temperature: number;
    abortSignal?: AbortSignal;
    disableToolCalls?: boolean;
    requestTimeoutMs?: number;
    /** Fired after each successful generateText with that call's token usage. */
    onUsage?: (u: TokenUsage) => void;
  }
): Promise<string> {
  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost, provider: opts.provider });
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

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
        timeoutMs,
        opts.abortSignal
      ));
      reportUsage(result, opts.onUsage);

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
    timeoutMs,
    opts.abortSignal
  ));
  reportUsage(textResult, opts.onUsage);

  const rawText = textResult.text || "";
  const final = extractFinalAnswerFromReasoning(rawText);
  if (final) return final;
  const single = coerceSingleTranslation(extractJsonFromText(rawText), rawText);
  if (single) return single;

  throw new Error("Model returned empty single-line translation text");
}
