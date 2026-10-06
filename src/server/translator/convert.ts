import { parseSync, stringifySync } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";
import { errorMessage } from "../errors.js";

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

export type AssSection = assParser.AssSection;
export type AssLine = assParser.AssLine;
/** An ASS/SSA file: the whole document, and its Dialogue lines as cues. */
export interface AssDocument {
  full: AssSection[];
  events: SubtitleCue[];
}
export type ParsedSubtitle = ReturnType<typeof parseSync> | AssDocument;

export const isAssDocument = (parsed: ParsedSubtitle): parsed is AssDocument => !Array.isArray(parsed);

/** A named field of a Style or Dialogue line; "" when the line is not a field map. */
export function assField(value: assParser.AssValue, name: string): string {
  return typeof value === "object" && !Array.isArray(value) ? (value[name] ?? "") : "";
}

/** The Dialogue line with its Text replaced; a line without a field map is left as it is. */
export function withDialogueText(line: AssLine, text: string): AssLine {
  if (typeof line.value !== "object" || Array.isArray(line.value)) return line;
  return { key: "Dialogue", value: { ...line.value, Text: text } };
}

/** The cues of any parsed subtitle, whatever its format. */
export function cuesOf(parsed: ParsedSubtitle): SubtitleCue[] {
  return isAssDocument(parsed) ? parsed.events : parsed.filter((node) => node.type === "cue");
}

/**
 * The `subtitle` parser only understands cue blocks. It throws on WebVTT STYLE
 * and REGION blocks and on a text cue identifier before the first cue, and it
 * folds a later text identifier into the previous cue's text. Drop both; the
 * parser discards identifiers anyway.
 */
function stripVttNonCueParts(content: string): string {
  return content
    .split(/(?:\r?\n[ \t]*){2,}/)
    .flatMap((block) => {
      const lines = block.split(/\r?\n/);
      if (/^(STYLE|REGION)[ \t]*$/.test(lines[0])) return [];
      const hasIdentifier = lines.length > 1 && !lines[0].includes("-->") && lines[1].includes("-->");
      return [(hasIdentifier ? lines.slice(1) : lines).join("\n")];
    })
    .join("\n\n");
}

export function parseSubtitle(fileContent: string, fileExtension: string): ParsedSubtitle {
  if (["srt", "vtt"].includes(fileExtension)) {
    return parseSync(fileExtension === "vtt" ? stripVttNonCueParts(fileContent) : fileContent);
  }
  if (["ass", "ssa"].includes(fileExtension)) {
    const parsedAss = assParser(fileContent);
    const events: SubtitleCue[] = parsedAss
      .filter((x) => x.section === "Events")[0]
      .body.filter(({ key }) => key === "Dialogue")
      .map((line) => ({
        type: "cue",
        data: {
          text: assField(line.value, "Text"),
          start: assField(line.value, "Start"),
          end: assField(line.value, "End"),
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
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

export function normalizeTimeToMs(value: number | string | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (/^\d{2}:\d{2}:\d{2}[,.]\d{3}$/.test(trimmed)) {
    const normalized = trimmed.replace(",", ".");
    const [hh, mm, ssMs] = normalized.split(":");
    const [ss, ms] = ssMs.split(".");
    return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number(ms);
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

export function buildAssDocumentFromCues(cues: SubtitleCue[]): AssSection[] {
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
          value: ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"],
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

  let parsed: ParsedSubtitle;
  try {
    parsed = parseSubtitle(content, from);
  } catch (error) {
    const reason = error instanceof Error ? errorMessage(error) : String(error);
    throw new Error(`Failed to parse ${from} subtitle: ${reason}`);
  }

  // parseSubtitle returns an array of nodes for srt/vtt (which may include a
  // non-cue "header" node for VTT), or { full, events } for ass/ssa.
  const cues = cuesOf(parsed);

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
  if (isAssDocument(parsed)) {
    let dialogueIndex = 0;
    return assStringify(
      parsed.full.map((section) => {
        if (section.section !== "Events" || !Array.isArray(section.body)) return section;
        return {
          ...section,
          body: section.body.map((line) => {
            if (line.key !== "Dialogue") return line;
            const cue = cues[dialogueIndex++];
            return withDialogueText(line, cue?.data?.text || assField(line.value, "Text"));
          }),
        };
      }),
    );
  }

  return assStringify(buildAssDocumentFromCues(cues));
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
