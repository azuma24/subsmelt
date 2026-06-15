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
      const backoff =
        delay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
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

  const rawText = textResult.text || "";
  const final = extractFinalAnswerFromReasoning(rawText);
  if (final) return final;
  const single = coerceSingleTranslation(extractJsonFromText(rawText), rawText);
  if (single) return single;

  throw new Error("Model returned empty single-line translation text");
}
