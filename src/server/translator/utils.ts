import fs from "node:fs";
import path from "node:path";
import { parseSync, stringifySync } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";
import type { ReasoningOutput } from "ai";

/** The parsed shape of a single subtitle cue shared across the translator. */
export interface SubtitleCue {
  type?: string;
  data?: {
    text?: string;
    translatedText?: string;
    start?: number | string;
    end?: number | string;
  };
}

/** Back-compat alias retained for internal call sites. */
export type CueLike = SubtitleCue;

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

function buildAssDocumentFromCues(cues: SubtitleCue[]): any[] {
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

const SUPPORTED_CONVERT_EXTS = ["srt", "vtt", "ass", "ssa"] as const;
export type ConvertExt = (typeof SUPPORTED_CONVERT_EXTS)[number];

/**
 * Pure format conversion: parse subtitle `content` (in `fromExt`) and
 * re-stringify the ORIGINAL cue text into `toExt`. No translation, no disk I/O —
 * returns the converted document as a string. Mirrors saveTranslated's
 * stringify logic but uses the original `text` (not `translatedText`).
 * Handles all combinations of {srt,vtt,ass,ssa} → {srt,vtt,ass,ssa}.
 */
export function convertSubtitle(content: string, fromExt: string, toExt: string): string {
  const from = fromExt.toLowerCase().replace(/^\./, "");
  const to = toExt.toLowerCase().replace(/^\./, "");
  if (!SUPPORTED_CONVERT_EXTS.includes(from as ConvertExt)) {
    throw new Error(`Unsupported source extension: ${fromExt}`);
  }
  if (!SUPPORTED_CONVERT_EXTS.includes(to as ConvertExt)) {
    throw new Error(`Unsupported target extension: ${toExt}`);
  }
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Subtitle content is empty");
  }

  let parsed: ReturnType<typeof parseSubtitle>;
  try {
    parsed = parseSubtitle(content, from);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${from} subtitle: ${reason}`);
  }

  // parseSubtitle returns an array of nodes for srt/vtt (which may include a
  // non-cue "header" node for VTT), or { full, events } for ass/ssa.
  const isAssSource = !Array.isArray(parsed);
  const cues: SubtitleCue[] = isAssSource
    ? (parsed as { full: any[]; events: SubtitleCue[] }).events
    : (parsed as SubtitleCue[]).filter((node) => node?.type === "cue");

  if (!Array.isArray(cues) || cues.length === 0) {
    throw new Error(`No subtitle cues found in ${from} input`);
  }

  if (["srt", "vtt"].includes(to)) {
    const format = to === "vtt" ? "WebVTT" : "SRT";
    return stringifySync(
      cues.map((cue: SubtitleCue) => ({
        type: "cue",
        data: {
          ...cue.data,
          start: normalizeTimeToMs(cue?.data?.start),
          end: normalizeTimeToMs(cue?.data?.end),
          // Pure conversion: keep the ORIGINAL text.
          text: cue?.data?.text || "",
        },
      })),
      { format },
    );
  }

  // Target is ass/ssa. When the source is already ass/ssa we preserve the full
  // document (styles, script info) and just rewrite Dialogue text from the
  // original cues. Otherwise we build a fresh ASS document from the cues.
  if (isAssSource) {
    const full = (parsed as { full: any[] }).full;
    let dialogueIndex = 0;
    return assStringify(
      full.map((section: any) => {
        if (section.section !== "Events" || !Array.isArray(section.body)) return section;
        return {
          ...section,
          body: section.body.map((line: any) => {
            if (line.key !== "Dialogue") return line;
            const cue = cues[dialogueIndex++];
            const text = cue?.data?.text || line.value?.Text || "";
            return { key: "Dialogue", value: { ...line.value, Text: text } };
          }),
        };
      }),
    );
  }

  return assStringify(buildAssDocumentFromCues(cues));
}

export function saveTranslated(
  outputPath: string,
  parsedSubtitle: any,
  outputExtension: string,
  cues: SubtitleCue[]
) {
  let newSubtitle: string;
  const ext = outputExtension.toLowerCase();

  if (["srt", "vtt"].includes(ext)) {
    const format = ext === "vtt" ? "WebVTT" : "SRT";
    newSubtitle = stringifySync(
      cues.map((x: SubtitleCue) => ({
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

// ── Secret/snippet helpers ───────────────────────────────────────────────────

export function sanitizeSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***")
    .replace(/("api[_-]?key"\s*:\s*")[^"]+("?)/gi, "$1***$2");
}

export function truncate(text: string, max = 600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function toSnippet(value: unknown, max = 600): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return truncate(sanitizeSecrets(value), max);
  try {
    return truncate(sanitizeSecrets(JSON.stringify(value)), max);
  } catch {
    return truncate(String(value), max);
  }
}

// ── JSON / reasoning extraction helpers ──────────────────────────────────────

/** Extract plain text from AI SDK reasoning output (may be string or ReasoningOutput[]). */
export function extractReasoningText(reasoning: string | ReasoningOutput[] | undefined): string {
  if (!reasoning) return "";
  if (typeof reasoning === "string") return reasoning;
  return reasoning.map((r) => ("text" in r ? r.text : "")).join("");
}

export function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function extractJsonFromText(value: string): unknown {
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

export function stripMarkdownFences(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

export function coerceTranslatedArray(parsed: unknown): string[] | null {
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

export function coerceSingleTranslation(parsed: unknown, rawText: string): string | null {
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
export function extractFinalAnswerFromReasoning(reasoning: string): string | null {
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
export function extractNumberedTranslations(text: string, expectedCount: number): string[] | null {
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

export function splitIntoChunks(array: SubtitleCue[], by = 20): SubtitleCue[][] {
  const chunks: SubtitleCue[][] = [];
  let chunk: SubtitleCue[] = [];
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
