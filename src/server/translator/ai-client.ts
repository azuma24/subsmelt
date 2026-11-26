import { type LanguageModel, type ToolSet, streamText, tool } from "ai";
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
import { ContextOverflowError, toContextOverflow } from "./context-overflow.js";
import { llmFetch } from "./llm-fetch.js";
import { collectReply } from "./stream-reply.js";
import type { JobProgress } from "./job-progress.js";

import type { LlmProvider } from "../../shared/llm.js";
import { errorMessage, errorName, errorStatus } from "../errors.js";

/** The provider a connection talks to; the API calls this LlmProvider. */
export type CloudProvider = LlmProvider;

/**
 * Token usage captured from a single LLM call, in the AI SDK's names.
 * Cache and reasoning counts are breakdowns: cache reads and writes are part of
 * `inputTokens`, reasoning is part of `outputTokens`.
 */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

/**
 * Defensively extract a normalised {@link TokenUsage} from an LLM result.
 * Reads the AI SDK's `inputTokenDetails`/`outputTokenDetails` breakdowns and
 * falls back to the legacy `promptTokens`/`completionTokens` names, treating
 * missing fields as 0. Returns null when no input or output was reported.
 */
export function extractUsage(result: unknown): TokenUsage | null {
  const usage = (result as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const details = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const inputTokens = num(usage.inputTokens) || num(usage.promptTokens);
  const outputTokens = num(usage.outputTokens) || num(usage.completionTokens);
  if (inputTokens === 0 && outputTokens === 0) return null;
  const input = details(usage.inputTokenDetails);
  const output = details(usage.outputTokenDetails);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: num(input.cacheReadTokens),
    cacheWriteTokens: num(input.cacheWriteTokens),
    reasoningTokens: num(output.reasoningTokens),
  };
}

/** Fire an onUsage callback for an LLM result, swallowing extraction failures. */
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
  const err = (error !== null && typeof error === "object" ? error : null) as {
    responseHeaders?: unknown;
    response?: { headers?: unknown } | null;
    headers?: unknown;
  } | null;
  const status = errorStatus(error);

  const msg = errorMessage(error).toLowerCase();
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

/**
 * Validate that a user-configured host is an http(s) URL. This is a self-hosted,
 * user-owned endpoint, so we deliberately do NOT block loopback/LAN here
 * (localhost LM Studio is the common case) — we only enforce the scheme to keep
 * non-http schemes (file:, ftp:, data:, …) out of the HTTP client. SSRF range
 * checks live at the probe-fetch layer (probeModelContext) where an outbound
 * request is actually made on the user's behalf.
 */
export function assertHttpScheme(apiHost: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiHost);
  } catch {
    throw new Error(`Invalid API host URL: ${apiHost}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`API host must use http(s): ${apiHost}`);
  }
}

export function getAi({ apiKey, apiHost, provider }: { apiKey: string; apiHost: string; provider?: CloudProvider }) {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey: apiKey || "", fetch: llmFetch });
    case "anthropic":
      return createAnthropic({ apiKey: apiKey || "", fetch: llmFetch });
    case "gemini":
      return createGoogleGenerativeAI({ apiKey: apiKey || "", fetch: llmFetch });
    default:
      // Enforce http(s) on the user-configured baseURL before it reaches the
      // HTTP client. Keeps non-http schemes out; LAN/loopback hosts are allowed.
      assertHttpScheme(apiHost);
      return createOpenAICompatible({
        name: "openai",
        apiKey: apiKey || "sk-dummy",
        baseURL: apiHost,
        fetch: llmFetch,
        // Streamed replies carry token usage only when the request asks for it.
        includeUsage: true,
      });
  }
}

/** Module-level default — overridden per-job via TranslateFileOptions.requestTimeoutMs */
export const REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.TRANSLATION_REQUEST_TIMEOUT_MS || "300000", 10) || 300_000,
);

/**
 * Normalise an LLM result so callers never need to check reasoning.
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

/** A streamed reply may run this many idle timeouts in total before it is cut off. */
export const STREAM_TOTAL_TIMEOUT_FACTOR = 3;

class RequestTimeoutError extends Error {}

/**
 * The error an aborted signal should surface: a deliberate per-job cancel
 * keeps its identity; every other abort — requestStop's "stop_requested"
 * string, a bare abort — reads as a queue stop.
 */
export function controlledAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error && reason.message === "JOB_CANCELLED" ? reason : new Error("STOP_REQUESTED");
}

/** `idleMs` restarts on every `noteActivity()`; `totalMs` never restarts. */
interface RequestLimits {
  idleMs?: number;
  totalMs: number;
  totalMessage: string;
  /** A limit reached while the job is still translating lines waits until the job stalls. */
  progress?: JobProgress;
}

async function withRequestLimits<T>(
  run: (signal: AbortSignal, noteActivity: () => void) => Promise<T>,
  limits: RequestLimits,
  externalSignal?: AbortSignal,
): Promise<T> {
  // If external signal is already aborted, short-circuit immediately
  if (externalSignal?.aborted) throw new Error("STOP_REQUESTED");

  const controller = new AbortController();
  let timeoutMessage = limits.totalMessage;
  const expire = (message: string, checkAgainIn: (ms: number) => void) => {
    const untilStalled = limits.progress?.msUntilStalled() ?? 0;
    if (untilStalled > 0) {
      checkAgainIn(untilStalled);
      return;
    }
    timeoutMessage = limits.progress
      ? `${message}, and the job translated no new line for ${limits.progress.stallMs}ms`
      : message;
    controller.abort("timeout");
  };
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const armTotal = (ms: number) => {
    totalTimer = setTimeout(() => expire(limits.totalMessage, armTotal), ms);
  };
  armTotal(limits.totalMs);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (ms: number) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire(`Request timeout: no output for ${limits.idleMs}ms`, armIdle), ms);
  };
  const noteActivity = () => {
    if (limits.idleMs !== undefined) armIdle(limits.idleMs);
  };
  noteActivity();

  // Forward external abort into our controller so in-flight LLM calls cancel instantly
  const onExternalAbort = () => controller.abort(externalSignal!.reason);
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    // Awaited to its end even after an abort: the queue is released only once in-flight requests have settled.
    return await run(controller.signal, noteActivity);
  } catch (error) {
    // Distinguish stop/cancel vs timeout: only a deliberate per-job cancel
    // keeps its identity.
    if (externalSignal?.aborted) throw controlledAbortError(externalSignal);
    // fetch rejects with the abort reason ("timeout"), not an AbortError, so
    // our own signal is what marks a timeout — unless the reason came from the
    // external stop/cancel forwarded into it.
    if (errorMessage(error) === "JOB_CANCELLED" || errorMessage(error) === "STOP_REQUESTED") throw error;
    if (controller.signal.aborted || errorName(error) === "AbortError") {
      throw new RequestTimeoutError(timeoutMessage);
    }
    // Wrap non-object throws (plain strings, numbers) so they always have .message
    if (error !== null && typeof error !== "object") {
      throw new Error(String(error));
    }
    throw toContextOverflow(error) ?? error;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Runs one request under a limit on its total duration. */
export function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = REQUEST_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<T> {
  return withRequestLimits(
    run,
    { totalMs: timeoutMs, totalMessage: `Request timeout after ${timeoutMs}ms` },
    externalSignal,
  );
}

/** The streamText settings a translation call chooses; the rest are fixed by {@link streamReply}. */
interface StreamRequest {
  model: LanguageModel;
  temperature: number;
  system: string;
  prompt: string;
  tools?: ToolSet;
  toolChoice?: "required";
  maxOutputTokens?: number;
  cutOffRetry?: CutOffRetry;
}

/**
 * What to do when a reply runs into the output limit: ask once more, on the
 * same connection, at this reasoning effort. A model that reasoned its whole
 * allowance away then answers itself, where the job would otherwise move the
 * lines to another model.
 */
export interface CutOffRetry {
  effort: string;
  /** Receives the cut-off attempt's token usage; the caller reports the retry's. */
  onUsage?: (u: TokenUsage) => void;
}

/** The retry for a call's options, or none when its connection sets no retry effort. */
export function cutOffRetryFor(opts: {
  cutOffRetryEffort?: string;
  onUsage?: (u: TokenUsage) => void;
}): CutOffRetry | undefined {
  return opts.cutOffRetryEffort ? { effort: opts.cutOffRetryEffort, onUsage: opts.onUsage } : undefined;
}

/**
 * Request settings that ask an OpenAI-compatible server for a reasoning effort.
 * "openai" is the name {@link getAi} gives the compatible provider.
 */
export function reasoningEffortSettings(effort: string) {
  return { providerOptions: { openai: { reasoningEffort: effort } } };
}

/** Output a self-hosted model may spend on reasoning before it answers. */
const REPLY_REASONING_OUTPUT_TOKENS = 8_000;
/** Output allowed on top of that for each line to translate. */
const REPLY_OUTPUT_TOKENS_PER_LINE = 400;

/**
 * The most output a translation reply of `lines` lines may use. A self-hosted
 * server sets no limit of its own, so a model that never stops generates until
 * its context is full, which holds up the server's other requests for as long.
 * Cloud providers end such a reply at their model's own limit, which can be
 * lower than this one.
 */
function replyOutputTokenCap(provider: CloudProvider | undefined, lines: number): number | undefined {
  if (provider) return undefined;
  return REPLY_REASONING_OUTPUT_TOKENS + REPLY_OUTPUT_TOKENS_PER_LINE * lines;
}

/**
 * Streams one reply and resolves with its final step. `timeoutMs` limits the
 * time without output, the wait for the first part included, so a slow model
 * that keeps producing is not cut off; {@link STREAM_TOTAL_TIMEOUT_FACTOR}
 * times that ends a reply that never finishes. With `progress`, neither limit
 * ends the request while the job is still translating lines.
 */
export async function streamReply(
  { cutOffRetry, ...request }: StreamRequest,
  timeoutMs = REQUEST_TIMEOUT_MS,
  externalSignal?: AbortSignal,
  progress?: JobProgress,
) {
  const totalMs = timeoutMs * STREAM_TOTAL_TIMEOUT_FACTOR;
  const send = (settings: StreamRequest | (StreamRequest & ReturnType<typeof reasoningEffortSettings>)) =>
    withRequestLimits(
      (abortSignal, noteActivity) =>
        // Errors reach the caller through collectReply; the SDK's default handler would also log them.
        collectReply(streamText({ ...settings, maxRetries: 0, abortSignal, onError: () => {} }), noteActivity),
      {
        idleMs: timeoutMs,
        totalMs,
        totalMessage: `Request timeout: reply still unfinished at the ${totalMs}ms total limit`,
        progress,
      },
      externalSignal,
    );
  const reply = await send(request);
  if (!cutOffRetry || !cutOff(reply)) return reply;
  reportUsage(reply, cutOffRetry.onUsage);
  return send({ ...request, ...reasoningEffortSettings(cutOffRetry.effort) });
}

/**
 * True when an error looks like a transport stall rather than a bad response.
 *
 * A schema mismatch is the model misbehaving on one chunk, not the endpoint
 * being down — dropping a connection for that would be wrong.
 *
 * Note "timed out" as well as "timeout": the phrasing differs by layer
 * (`Request timeout after 300000ms` from ai-client, `... timed out after 300s`
 * from the transcription client), and matching only one of them meant the
 * breaker never tripped on the most common message.
 */
const TRANSPORT_MARKERS = [
  "timed out",
  "timeout",
  "etimedout",
  "network",
  "fetch failed",
  "econnreset",
  "econnrefused",
  "socket hang up",
];

export function isTransportFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return TRANSPORT_MARKERS.some((marker) => message.includes(marker));
}
/** A retry backoff can honour Retry-After for up to a minute, so Stop and Cancel must be able to end it. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(controlledAbortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(controlledAbortError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryTranslate<T>(
  fn: (attempt: number) => Promise<T>,
  maxRetries = 5,
  delay = 1000,
  onRetry?: (attempt: number, error: unknown, backoff: number, maxRetries?: number) => void,
  abortSignal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt === maxRetries) throw error;
      const msg = (errorMessage(error) || "").toLowerCase();
      // Never retry a stop request — propagate immediately
      if (msg === "stop_requested") throw error;
      const isRetryable =
        isTransportFailure(error) ||
        msg.includes("rate limit") ||
        msg.includes("no object generated") ||
        msg.includes("did not match schema") ||
        msg.includes("validation") ||
        msg.includes("empty single-line translation") ||
        // Only retry rate-limit (429) and transient server errors (5xx).
        // Permanent 4xx like 400 (bad request) / 401 (invalid key) must NOT
        // be retried — they only waste tokens/time and never succeed.
        errorStatus(error) === 429 ||
        (errorStatus(error) ?? 0) >= 500;
      if (!isRetryable) throw error;
      // Rate-limit aware backoff: when the server says 429/503, honor Retry-After
      // (capped) instead of the default exponential schedule. A 429 with no
      // Retry-After falls back to exponential too.
      const rateLimitMs = rateLimitRetryDelayMs(error);
      const exponential = delay * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      const backoff = rateLimitMs && rateLimitMs > 0 ? rateLimitMs : exponential;
      // maxRetries is threaded through so callers can log a truthful "n/N".
      onRetry?.(attempt, error, backoff, maxRetries);
      await abortableDelay(backoff, abortSignal);
    }
  }
  throw new Error("Unreachable");
}

/**
 * A reply that ran into the output limit holds no finished answer. What can be
 * read out of it is a fragment, or a candidate the model was still weighing.
 */
const cutOff = (result: { finishReason: string }) => result.finishReason === "length";

export class InvalidChunkTranslationError extends Error {
  constructor(expected: number, received: number | undefined, finishReason: string) {
    const receivedSummary = received === undefined ? "no array" : `${received} received`;
    super(
      `Model did not return a valid translated array payload (${expected} cues requested, ${receivedSummary}, finish reason: ${finishReason})`,
    );
  }
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
    /** The job's line clock; see {@link streamReply}. */
    progress?: JobProgress;
    /** Optional read-only context lines prepended to the prompt. */
    contextPromptPrefix?: string;
    /** Fired after each successful LLM call with its token usage. */
    onUsage?: (u: TokenUsage) => void;
    /** Reasoning effort to ask a cut-off reply for again; see {@link CutOffRetry}. */
    cutOffRetryEffort?: string;
  },
): Promise<string[]> {
  if (opts.abortSignal?.aborted) throw controlledAbortError(opts.abortSignal);
  const nonblankSubtitles = subtitles.filter((subtitle) => subtitle.trim());
  if (nonblankSubtitles.length === 0) return subtitles.map(() => "");
  if (nonblankSubtitles.length !== subtitles.length) {
    const translated = await translateChunk(nonblankSubtitles, opts);
    let index = 0;
    return subtitles.map((subtitle) => (subtitle.trim() ? translated[index++] : ""));
  }

  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost, provider: opts.provider });
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const prefix = opts.contextPromptPrefix || "";
  const maxOutputTokens = replyOutputTokenCap(opts.provider, subtitles.length);

  if (!opts.disableToolCalls) {
    const toolResult: { translated?: string[] } = {};
    const tools = {
      submit_translation: tool({
        description: "Provide the final translated subtitles. Keep order and length identical to input.",
        inputSchema: z
          .object({
            translated: z.array(z.string().describe("Translated subtitle at the same index")),
          })
          .strict(),
        execute: async ({ translated }) => {
          toolResult.translated = translated;
          return JSON.stringify(translated);
        },
      }),
    } as const;

    try {
      const result = normalizeResult(
        await streamReply(
          {
            model: ai(opts.model),
            temperature: opts.temperature,
            maxOutputTokens,
            cutOffRetry: cutOffRetryFor(opts),
            tools,
            toolChoice: "required",
            system: opts.systemPrompt + "\nReturn ONLY using the tool, do not include any extra text.",
            prompt:
              `${prefix}Translate the following subtitles. Return the result via the tool as an array of strings with the exact same length and order as input.\n\n` +
              JSON.stringify(subtitles),
          },
          timeoutMs,
          opts.abortSignal,
          opts.progress,
        ),
      );
      reportUsage(result, opts.onUsage);

      const fromTool = toolResult.translated;
      if (fromTool?.length === subtitles.length) return fromTool;

      const text = cutOff(result) ? "" : result.text || "";
      const fromText = coerceTranslatedArray(extractJsonFromText(text));
      if (fromText?.length === subtitles.length) return fromText;
      const fromNumbered = extractNumberedTranslations(text, subtitles.length);
      if (fromNumbered) return fromNumbered;
    } catch (e) {
      if (
        errorMessage(e) === "STOP_REQUESTED" ||
        errorMessage(e) === "JOB_CANCELLED" ||
        e instanceof RequestTimeoutError
      )
        throw e;
      // The plain-text prompt is the same size, so it would overflow too.
      if (e instanceof ContextOverflowError) throw e;
      // fall through to plain-text path
    }
  }

  const textResult = normalizeResult(
    await streamReply(
      {
        model: ai(opts.model),
        temperature: opts.temperature,
        maxOutputTokens,
        cutOffRetry: cutOffRetryFor(opts),
        system: opts.systemPrompt + "\nReturn only JSON array of strings. No markdown, no prose.",
        prompt:
          `${prefix}Translate the following subtitles. Return ONLY a JSON array of translated strings with the exact same length and order as input.\n\n` +
          JSON.stringify(subtitles),
      },
      timeoutMs,
      opts.abortSignal,
      opts.progress,
    ),
  );
  reportUsage(textResult, opts.onUsage);

  const text = cutOff(textResult) ? "" : textResult.text || "";
  const translated = coerceTranslatedArray(extractJsonFromText(text));
  if (translated?.length === subtitles.length) return translated;

  const fromNumbered = extractNumberedTranslations(text, subtitles.length);
  if (fromNumbered) return fromNumbered;

  throw new InvalidChunkTranslationError(subtitles.length, translated?.length, textResult.finishReason);
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
    /** The job's line clock; see {@link streamReply}. */
    progress?: JobProgress;
    /** Fired after each successful LLM call with its token usage. */
    onUsage?: (u: TokenUsage) => void;
    /** Reasoning effort to ask a cut-off reply for again; see {@link CutOffRetry}. */
    cutOffRetryEffort?: string;
  },
): Promise<string> {
  if (opts.abortSignal?.aborted) throw controlledAbortError(opts.abortSignal);
  if (!subtitle.trim()) return "";

  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost, provider: opts.provider });
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxOutputTokens = replyOutputTokenCap(opts.provider, 1);

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
      const result = normalizeResult(
        await streamReply(
          {
            model: ai(opts.model),
            temperature: opts.temperature,
            maxOutputTokens,
            cutOffRetry: cutOffRetryFor(opts),
            tools,
            toolChoice: "required",
            system: opts.systemPrompt + "\nReturn ONLY using the tool, do not include any extra text.",
            prompt:
              "Translate the following subtitle. Return the result via the tool as plain text only.\n\n" +
              JSON.stringify(subtitle),
          },
          timeoutMs,
          opts.abortSignal,
          opts.progress,
        ),
      );
      reportUsage(result, opts.onUsage);

      if (typeof toolResult === "string") return toolResult;

      // normalizeResult promoted reasoning→text; extract best answer
      const text = cutOff(result) ? "" : result.text || "";
      if (text) {
        const final = extractFinalAnswerFromReasoning(text);
        if (final) return final;
        const single = coerceSingleTranslation(extractJsonFromText(text), text);
        if (single) return single;
      }
    } catch (e) {
      if (
        errorMessage(e) === "STOP_REQUESTED" ||
        errorMessage(e) === "JOB_CANCELLED" ||
        e instanceof RequestTimeoutError
      )
        throw e;
      // The plain-text prompt is the same size, so it would overflow too.
      if (e instanceof ContextOverflowError) throw e;
      // fall through to plain-text path
    }
  }

  const textResult = normalizeResult(
    await streamReply(
      {
        model: ai(opts.model),
        temperature: opts.temperature,
        maxOutputTokens,
        cutOffRetry: cutOffRetryFor(opts),
        system: opts.systemPrompt + "\nReturn plain translated text only. No explanations, no markdown.",
        prompt:
          "Translate the following subtitle line and return only the translated text.\n\n" + JSON.stringify(subtitle),
      },
      timeoutMs,
      opts.abortSignal,
      opts.progress,
    ),
  );
  reportUsage(textResult, opts.onUsage);

  if (cutOff(textResult)) {
    throw new Error("Model returned empty single-line translation text: the reply was cut off at the output limit");
  }
  const rawText = textResult.text || "";
  const final = extractFinalAnswerFromReasoning(rawText);
  if (final) return final;
  const single = coerceSingleTranslation(extractJsonFromText(rawText), rawText);
  if (single) return single;

  throw new Error("Model returned empty single-line translation text");
}
