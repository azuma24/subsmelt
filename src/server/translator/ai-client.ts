import { generateText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

export function getAi({ apiKey, apiHost }: { apiKey: string; apiHost: string }) {
  return createOpenAICompatible({
    name: "openai",
    apiKey: apiKey || "sk-dummy",
    baseURL: apiHost,
  });
}

export async function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function translateChunk(
  subtitles: string[],
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    systemPrompt: string;
    temperature: number;
  }
): Promise<string[]> {
  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost });

  let toolResult: string[] | null = null;
  const tools = {
    submit_translation: tool({
      description: "Provide the final translated subtitles. Keep order and length identical to input.",
      inputSchema: z.object({
        translated: z.array(z.string().describe("Translated subtitle at the same index")),
      }).strict(),
      execute: async ({ translated }) => {
        toolResult = translated;
        return JSON.stringify(translated);
      },
    }),
  } as const;

  try {
    await withAbortTimeout(
      (abortSignal) =>
        generateText({
          model: ai(opts.model),
          temperature: opts.temperature,
          tools,
          toolChoice: "required",
          system: opts.systemPrompt + "\nReturn ONLY using the tool, do not include any extra text.",
          prompt: "Translate the following subtitles. Return the result via the tool as an array of strings with the exact same length and order as input.\n\n" + JSON.stringify(subtitles),
          maxRetries: 0,
          abortSignal,
        }),
      45000
    );

    if (toolResult && Array.isArray(toolResult)) return toolResult;
  } catch {
    // fall through
  }

  const textResult = await withAbortTimeout(
    (abortSignal) =>
      generateText({
        model: ai(opts.model),
        temperature: opts.temperature,
        system: opts.systemPrompt + "\nReturn only JSON array of strings. No markdown, no prose.",
        prompt: "Translate the following subtitles. Return ONLY a JSON array of translated strings with the exact same length and order as input.\n\n" + JSON.stringify(subtitles),
        maxRetries: 0,
        abortSignal,
      }),
    45000
  );

  // Logic for extracting JSON and coercing array would go here (will move from utils/translator)
  return []; // Placeholder
}
