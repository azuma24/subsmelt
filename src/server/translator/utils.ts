import fs from "node:fs";
import path from "node:path";
import { parseSync, stringifySync } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";

export interface CueLike {
  type?: string;
  data?: {
    text?: string;
    translatedText?: string;
    start?: number | string;
    end?: number | string;
  };
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

export function toAssTimestamp(value: number | string | undefined): string {
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
            "Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour", "OutlineColour", "BackColour", "Bold", "Italic", "Underline", "StrikeOut", "ScaleX", "ScaleY", "Spacing", "Angle", "BorderStyle", "Outline", "Shadow", "Alignment", "MarginL", "MarginR", "MarginV", "Encoding",
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
            "Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text",
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

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
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

  try {
    fs.chmodSync(outputPath, 0o666);
  } catch {}
}

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
