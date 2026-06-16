import fs from "node:fs";
import path from "node:path";
import { parseSync, stringifySync } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";
import jschardet from "jschardet";
import iconv from "iconv-lite";
import type { ReasoningOutput } from "ai";

/**
 * Read a subtitle file from disk and return its content as a clean UTF-8 JS
 * string, transparently handling legacy non-UTF-8 encodings and byte-order
 * marks (BOMs) so older subtitle files no longer mojibake or fail to parse.
 *
 * Strategy:
 *   1. Read the raw bytes (no encoding hint).
 *   2. If a UTF-8 BOM (EF BB BF) is present, strip it and decode as UTF-8.
 *   3. If a UTF-16 LE (FF FE) or BE (FE FF) BOM is present, decode as UTF-16.
 *   4. Otherwise sniff the charset with jschardet; when confidence is
 *      reasonable and the detected charset is not already UTF-8/ASCII, decode
 *      with iconv-lite. Default to UTF-8 in every other case.
 *
 * Defensive by design: any detection/decoding failure falls back to a plain
 * UTF-8 decode, so this helper never throws where the previous
 * `fs.readFileSync(path, "utf8")` would have succeeded.
 */
export function readSubtitleFileText(filePath: string): string {
  const buffer = fs.readFileSync(filePath);

  // BOM handling — explicit and unambiguous, checked before any sniffing.
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    // UTF-8 with BOM: strip the 3 BOM bytes, decode the rest as UTF-8.
    return buffer.subarray(3).toString("utf8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    // UTF-16 LE BOM. Node's "utf16le" decode does NOT strip the BOM, so drop
    // the leading 2 BOM bytes ourselves to avoid a stray U+FEFF char.
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // UTF-16 BE BOM. Node has no native utf16be; swap byte pairs to LE, then
    // drop the (now-LE) BOM bytes.
    const body = buffer.subarray(2);
    const swapped = Buffer.from(body);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = tmp;
    }
    return swapped.toString("utf16le");
  }

  // No BOM: sniff the charset and decode via iconv-lite when warranted.
  try {
    const detected = jschardet.detect(buffer);
    const encoding = (detected?.encoding || "").toLowerCase();
    const confidence = detected?.confidence ?? 0;
    const isUtf8OrAscii =
      encoding === "" ||
      encoding === "utf-8" ||
      encoding === "utf8" ||
      encoding === "ascii";

    if (!isUtf8OrAscii && confidence >= 0.6 && iconv.encodingExists(encoding)) {
      return iconv.decode(buffer, encoding);
    }
  } catch {
    // Detection failed — fall through to a safe UTF-8 decode.
  }

  // Common case (and safe fallback): decode as UTF-8, identical to the old
  // `fs.readFileSync(path, "utf8")` behavior.
  return buffer.toString("utf8");
}

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

/** A single manual edit from the preview UI. `index` is the 1-based cue index
 * exposed by the preview rows; `text` is the new translated text for that cue. */
export interface CueEdit {
  index: number;
  text: string;
}

/**
 * Apply manual translated-text edits to an ALREADY-TRANSLATED subtitle document
 * and re-stringify it in the same format. Unlike saveTranslated (which reads
 * `translatedText`), the output file's cue `text` already IS the translated
 * text, so edits rewrite the cue text in place by position.
 *
 * `content` is the parsed output-file text (its current contents); `ext` is the
 * output extension (srt/vtt/ass/ssa). `edits` carry 1-based cue indices matching
 * the preview rows. Out-of-range / non-finite indices are skipped and counted.
 *
 * For srt/vtt the Nth cue (`type === "cue"`) is rewritten. For ass/ssa the full
 * document (Script Info, Styles) is preserved and only the Nth Dialogue's Text
 * is changed, mirroring saveTranslated's ASS branch.
 *
 * Returns the new document string plus the number of cues actually updated.
 */
export function applyCueEdits(
  content: string,
  ext: string,
  edits: CueEdit[]
): { output: string; updated: number } {
  const normalizedExt = ext.toLowerCase().replace(/^\./, "");

  // Build a position→text map (0-based) from the 1-based edit indices, skipping
  // anything non-finite. Range validation happens against the actual cue count
  // below so callers can report how many edits were applied.
  const editByPosition = new Map<number, string>();
  for (const edit of edits) {
    if (!edit || typeof edit.index !== "number" || !Number.isFinite(edit.index)) continue;
    if (typeof edit.text !== "string") continue;
    const pos = Math.trunc(edit.index) - 1;
    if (pos < 0) continue;
    editByPosition.set(pos, edit.text);
  }

  let updated = 0;

  if (["srt", "vtt"].includes(normalizedExt)) {
    const parsed = parseSync(content);
    let cuePosition = 0;
    const rebuilt = parsed.map((node: any) => {
      if (node?.type !== "cue") return node;
      const pos = cuePosition++;
      if (editByPosition.has(pos)) {
        updated++;
        return {
          ...node,
          data: {
            ...node.data,
            start: normalizeTimeToMs(node?.data?.start),
            end: normalizeTimeToMs(node?.data?.end),
            text: editByPosition.get(pos) ?? node?.data?.text ?? "",
          },
        };
      }
      return {
        ...node,
        data: {
          ...node.data,
          start: normalizeTimeToMs(node?.data?.start),
          end: normalizeTimeToMs(node?.data?.end),
          text: node?.data?.text ?? "",
        },
      };
    });
    const format = normalizedExt === "vtt" ? "WebVTT" : "SRT";
    return { output: stringifySync(rebuilt, { format }), updated };
  }

  if (["ass", "ssa"].includes(normalizedExt)) {
    const parsedAss = assParser(content);
    let dialogueIndex = 0;
    const rebuilt = parsedAss.map((section: any) => {
      if (section.section !== "Events" || !Array.isArray(section.body)) return section;
      return {
        ...section,
        body: section.body.map((line: any) => {
          if (line.key !== "Dialogue") return line;
          const pos = dialogueIndex++;
          if (editByPosition.has(pos)) {
            updated++;
            const newText = String(editByPosition.get(pos) ?? "").replace(/\r?\n/g, "\\N");
            return { key: "Dialogue", value: { ...line.value, Text: newText } };
          }
          return line;
        }),
      };
    });
    return { output: assStringify(rebuilt), updated };
  }

  throw new Error(`Unsupported extension: ${normalizedExt}`);
}

/**
 * Write an already-stringified subtitle document to disk atomically. Shares the
 * tmp-rename + best-effort chmod strategy with saveTranslated so manual edits
 * persist with the same durability/permission guarantees.
 */
export function writeSubtitleFile(outputPath: string, content: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.renameSync(tmpPath, outputPath);
  } catch {
    fs.writeFileSync(outputPath, content, "utf8");
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
  try {
    fs.chmodSync(outputPath, 0o666);
  } catch {}
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

  // Atomic write + best-effort world-writable chmod (shared with manual edits).
  writeSubtitleFile(outputPath, newSubtitle);
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
