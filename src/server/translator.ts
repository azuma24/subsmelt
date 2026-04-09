import fs from "node:fs";
import path from "node:path";
import { parseSync, stringifySync } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";
import { z } from "zod";
import { generateObject, generateText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

function getAi({ apiKey, apiHost }: { apiKey: string; apiHost: string }) {
  return createOpenAICompatible({
    name: "openai",
    apiKey: apiKey || "sk-dummy",
    baseURL: apiHost,
  });
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
  }
): Promise<string[]> {
  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost });

  let toolResult: string[] | null = null;
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
    await generateText({
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
      maxRetries: 2,
    });

    if (toolResult && Array.isArray(toolResult)) return toolResult;
  } catch {
    // fall through to generateObject
  }

  const { object } = await generateObject({
    model: ai(opts.model),
    temperature: opts.temperature,
    schema: z.array(z.string().describe("The translated subtitles")),
    prompt:
      opts.systemPrompt +
      "\nOutput must be valid json. Respond with a JSON object that matches the schema. Return only JSON.\n\n" +
      JSON.stringify(subtitles),
    maxRetries: 3,
  });
  return object;
}

async function translateSingle(
  subtitle: string,
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    systemPrompt: string;
    temperature: number;
  }
): Promise<string> {
  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost });

  let toolResult: string | null = null;
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
    await generateText({
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
      maxRetries: 2,
    });

    if (typeof toolResult === "string") return toolResult;
  } catch {
    // fall through
  }

  const { object } = await generateObject({
    model: ai(opts.model),
    temperature: opts.temperature,
    schema: z.object({ result: z.string() }),
    prompt:
      opts.systemPrompt +
      "\nOutput must be valid json. Respond with a JSON object that matches the schema. Return only JSON.\n\n" +
      JSON.stringify(subtitle),
    maxRetries: 3,
  });
  return object.result;
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

export function saveTranslated(
  outputPath: string,
  parsedSubtitle: any,
  fileExtension: string
) {
  let newSubtitle: string;

  if (["srt", "vtt"].includes(fileExtension)) {
    const format = fileExtension === "vtt" ? "WebVTT" : "SRT";
    newSubtitle = stringifySync(
      parsedSubtitle.map((x: any) => ({
        type: x.type,
        data: {
          ...x.data,
          text: x.data.translatedText || x.data.text,
        },
      })),
      { format }
    );
  } else if (["ass", "ssa"].includes(fileExtension)) {
    const { full, events } = parsedSubtitle;
    let dialogueIndex = 0;
    newSubtitle = assStringify(
      full.map((x: any) => {
        if (x.section === "Events") {
          x.body = x.body.map((line: any) => {
            if (line.key === "Dialogue") {
              const currentEvent = events[dialogueIndex++];
              const translatedText =
                currentEvent?.data?.translatedText || line.value.Text;
              return {
                key: "Dialogue",
                value: { ...line.value, Text: translatedText },
              };
            }
            return line;
          });
        }
        return x;
      })
    );
  } else {
    throw new Error(`Unsupported extension: ${fileExtension}`);
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
  fn: () => Promise<T>,
  maxRetries = 5,
  delay = 1000,
  onRetry?: (attempt: number, error: any, backoff: number) => void
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt === maxRetries) throw error;
      const msg = (error?.message || "").toLowerCase();
      const isRetryable =
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("rate limit") ||
        msg.includes("no object generated") ||
        msg.includes("did not match schema") ||
        msg.includes("validation") ||
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
  additional: string;
  temperature: number;
  chunkSize: number;
  contextSize: number;
  onProgress?: (completed: number, total: number) => void;
  onRetry?: (attempt: number, error: any, backoff: number) => void;
}

export async function translateFile(opts: TranslateFileOptions): Promise<void> {
  const ext = path.extname(opts.srtPath).slice(1).toLowerCase();
  const content = fs.readFileSync(opts.srtPath, "utf8");
  const parsed = parseSubtitle(content, ext);

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

  const systemPrompt = opts.prompt
    .replaceAll("{{lang}}", opts.lang)
    .replaceAll("{{additional}}", opts.additional);

  const indexMap = new Map<any, number>();
  subtitle.forEach((cue, idx) => indexMap.set(cue, idx));

  const chunks = splitIntoChunks(subtitle, opts.chunkSize);
  let completedCues = 0;
  const contextSize = opts.contextSize;

  for (const block of chunks) {
    const coreIndices = block
      .map((cue: any) => indexMap.get(cue) as number)
      .filter((n: number) => typeof n === "number")
      .sort((a: number, b: number) => a - b);

    if (coreIndices.length === 0) continue;

    const coreStart = coreIndices[0];
    const coreEnd = coreIndices[coreIndices.length - 1];
    const contextStart = Math.max(0, coreStart - contextSize);
    const contextEnd = Math.min(subtitle.length - 1, coreEnd + contextSize);

    const windowCues = subtitle.slice(contextStart, contextEnd + 1);
    const windowText = windowCues.map((c: any) =>
      c?.data ? String(c.data.text).replace(/\n/g, " ").trim() : ""
    );

    let translatedWindow: string[] | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const attemptTemp = Math.max(
        0.1,
        Math.min(2, opts.temperature + (Math.random() - 0.5) * 0.4)
      );
      try {
        const result = await retryTranslate(
          () =>
            translateChunk(windowText, {
              apiKey: opts.apiKey,
              apiHost: opts.apiHost,
              model: opts.model,
              systemPrompt,
              temperature: attemptTemp,
            }),
          5,
          1000,
          opts.onRetry
        );
        if (Array.isArray(result) && result.length === windowText.length) {
          translatedWindow = result;
          break;
        }
      } catch {
        // continue
      }
    }

    // Single-line fallback
    if (!translatedWindow) {
      translatedWindow = new Array(windowText.length).fill(null);
      for (const idx of coreIndices) {
        const lineText = subtitle[idx]?.data?.text || "";
        const single = await retryTranslate(
          () =>
            translateSingle(lineText, {
              apiKey: opts.apiKey,
              apiHost: opts.apiHost,
              model: opts.model,
              systemPrompt,
              temperature: opts.temperature,
            }),
          5,
          1000,
          opts.onRetry
        );
        translatedWindow![idx - contextStart] = single;
      }
    }

    for (const cue of block) {
      const idx = indexMap.get(cue) as number;
      if (typeof idx !== "number") continue;
      const offset = idx - contextStart;
      const t = translatedWindow?.[offset];
      if (cue?.data && typeof t === "string") {
        cue.data.translatedText = t;
        completedCues++;
      }
    }

    opts.onProgress?.(completedCues, totalCues);

    // Partial save
    try {
      saveTranslated(opts.outputPath, parsed, ext);
    } catch {}
  }

  // Fallback for untranslated
  const untranslated = subtitle.filter((l: any) => !l.data?.translatedText);
  for (const cue of untranslated) {
    if (cue?.data) {
      cue.data.translatedText = await retryTranslate(
        () =>
          translateSingle(cue.data.text, {
            apiKey: opts.apiKey,
            apiHost: opts.apiHost,
            model: opts.model,
            systemPrompt,
            temperature: opts.temperature,
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
  saveTranslated(opts.outputPath, parsed, ext);
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
