import { generateText } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { getAi, normalizeResult, withAbortTimeout, REQUEST_TIMEOUT_MS, extractUsage, type CloudProvider, type TokenUsage } from "./ai-client.js";
import { coerceTranslatedArray, extractJsonFromText } from "./utils.js";

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

/**
 * Build the editor system prompt for the Refinement Pass (Pass 2). The editor
 * sees the original source lines and the pass-1 translation, and is asked to
 * improve only flow/tone while preserving meaning, glossary terms, and the
 * exact line count.
 */
export function buildRefineSystemPrompt(opts: { lang: string; additional: string }): string {
  const glossary = opts.additional?.trim()
    ? `\n\nPreserve these terms and any provided context exactly:\n${opts.additional}`
    : "";
  return (
    `You are a professional subtitle editor. You are given original subtitles and a draft translation into ${opts.lang}. ` +
    `Improve ONLY the naturalness, flow, and tone of the translation so it reads like fluent native ${opts.lang}. ` +
    `Do NOT change the meaning. Do NOT add or remove lines. Do NOT merge or split lines. ` +
    `Keep the array length and order identical to the input. ` +
    `If a line is already natural, return it unchanged.` +
    glossary
  );
}

/**
 * Refinement Pass (Pass 2). Returns a same-length refined array, or null if the
 * model fails or returns a mismatched length — in which case the caller keeps
 * the original pass-1 translation. Never throws except STOP_REQUESTED.
 */
export async function refineChunk(
  originalLines: string[],
  pass1Lines: string[],
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    provider?: CloudProvider;
    lang: string;
    additional: string;
    temperature: number;
    abortSignal?: AbortSignal;
    disableToolCalls?: boolean;
    requestTimeoutMs?: number;
    /** Fired after each successful generateText with that call's token usage. */
    onUsage?: (u: TokenUsage) => void;
  }
): Promise<string[] | null> {
  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost, provider: opts.provider });
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const systemPrompt = buildRefineSystemPrompt({ lang: opts.lang, additional: opts.additional });
  const pairs = originalLines.map((src, i) => ({ index: i, original: src, draft: pass1Lines[i] ?? "" }));
  const userPrompt =
    "Refine the 'draft' translations below. Return the result as an array of strings, " +
    "same length and order as input — one refined translation per item.\n\n" +
    JSON.stringify(pairs);

  const reportUsage = (result: unknown): void => {
    if (!opts.onUsage) return;
    const usage = extractUsage(result);
    if (usage) opts.onUsage(usage);
  };

  const accept = (arr: unknown): string[] | null =>
    Array.isArray(arr) && arr.length === originalLines.length && arr.every((s) => typeof s === "string")
      ? (arr as string[])
      : null;

  try {
    if (!opts.disableToolCalls) {
      let toolResult: string[] | null = null;
      const tools = {
        submit_refinement: tool({
          description: "Provide the final refined subtitles. Keep order and length identical to input.",
          inputSchema: z
            .object({ refined: z.array(z.string().describe("Refined subtitle at the same index")) })
            .strict(),
          execute: async ({ refined }) => {
            toolResult = refined;
            return JSON.stringify(refined);
          },
        }),
      } as const;

      const result = normalizeResult(await withAbortTimeout((abortSignal) =>
        generateText({
          model: ai(opts.model),
          temperature: opts.temperature,
          tools,
          toolChoice: "required",
          system: systemPrompt + "\nReturn ONLY using the tool, do not include any extra text.",
          prompt: userPrompt,
          maxRetries: 0,
          abortSignal,
        }),
        timeoutMs,
        opts.abortSignal
      ));
      reportUsage(result);

      const fromTool = accept(toolResult);
      if (fromTool) return fromTool;
      const fromText = accept(coerceTranslatedArray(extractJsonFromText(result.text || "")));
      if (fromText) return fromText;
    }

    const textResult = normalizeResult(await withAbortTimeout((abortSignal) =>
      generateText({
        model: ai(opts.model),
        temperature: opts.temperature,
        system: systemPrompt + "\nReturn only a JSON array of strings. No markdown, no prose.",
        prompt: userPrompt + "\n\nReturn ONLY a JSON array of refined strings, same length and order.",
        maxRetries: 0,
        abortSignal,
      }),
      timeoutMs,
      opts.abortSignal
    ));
    reportUsage(textResult);
    return accept(coerceTranslatedArray(extractJsonFromText(textResult.text || "")));
  } catch (e: any) {
    if (e?.message === "STOP_REQUESTED") throw e;
    return null; // refine is best-effort; caller keeps pass-1 output
  }
}
