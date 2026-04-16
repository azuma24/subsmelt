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

function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
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

  const baseMessage =
    typeof err?.message === "string" && err.message.trim().length > 0
      ? sanitizeSecrets(err.message.trim())
      : "Unknown translation error";

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

async function analyzeSubtitlesForContext(
  subtitles: string[],
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
  }
): Promise<string> {
  if (!opts.model || subtitles.length === 0) return "";

  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost });
  const temperature = opts.temperature ?? 0.3;

  try {
    const result = await generateText({
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
        subtitles.join("\n"),
      maxRetries: 2,
    });

    return result.text?.trim() || "";
  } catch {
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
  onAnalysis?: (analysis: string) => void;
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
  });

  if (analysis) {
    effectiveAdditional = `${effectiveAdditional ? `${effectiveAdditional}\n\n` : ""}[Context]\n${analysis}`;
    opts.onAnalysis?.(analysis);
  }

  const systemPrompt = opts.prompt
    .replaceAll("{{lang}}", opts.lang)
    .replaceAll("{{additional}}", effectiveAdditional);

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
      saveTranslated(opts.outputPath, parsed, outputExt, subtitle);
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
