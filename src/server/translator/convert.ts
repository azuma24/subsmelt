import { parseSync, stringifySync } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";

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

export function buildAssDocumentFromCues(cues: SubtitleCue[]): any[] {
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
