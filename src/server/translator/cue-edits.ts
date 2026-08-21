import fs from "node:fs";
import path from "node:path";
import { parseSync, stringifySync } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";
import { buildAssDocumentFromCues, normalizeTimeToMs, type SubtitleCue } from "./convert.js";

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
