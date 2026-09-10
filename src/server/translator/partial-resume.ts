import fs from "node:fs";
import type { SubtitleCue } from "./utils.js";

/** Sidecar next to `<output>.part` that records which cues already have translations. */
export const PROGRESS_SUFFIX = ".part.progress.json";

export interface PartialProgress {
  version: 1;
  totalCues: number;
  /** Parallel to source cues: translated text, or null when not yet done. */
  translations: Array<string | null>;
}

export function partialProgressPath(outputPath: string): string {
  return `${outputPath}${PROGRESS_SUFFIX}`;
}

export function isPartialProgress(value: unknown): value is PartialProgress {
  if (!value || typeof value !== "object") return false;
  const v = value as PartialProgress;
  return (
    v.version === 1 &&
    typeof v.totalCues === "number" &&
    Number.isFinite(v.totalCues) &&
    Array.isArray(v.translations) &&
    v.translations.length === v.totalCues &&
    v.translations.every((t) => t === null || typeof t === "string")
  );
}

/** Load durable mid-file progress. Returns null when missing/corrupt/mismatched. */
export function loadPartialProgress(outputPath: string, expectedTotal: number): PartialProgress | null {
  const path = partialProgressPath(outputPath);
  try {
    if (!fs.existsSync(path)) return null;
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    if (!isPartialProgress(parsed)) return null;
    if (parsed.totalCues !== expectedTotal) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist progress atomically beside the `.part` file. Best-effort (never throws). */
export function savePartialProgress(outputPath: string, progress: PartialProgress): void {
  const path = partialProgressPath(outputPath);
  const tmp = `${path}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(progress), "utf8");
    try {
      fs.renameSync(tmp, path);
    } catch {
      fs.writeFileSync(path, JSON.stringify(progress), "utf8");
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* best-effort — final rename of .part is authoritative */
  }
}

/** Remove `.part` and progress sidecar after a successful finish or a discarded resume. */
export function clearPartialArtifacts(outputPath: string, partialPath: string): void {
  for (const p of [partialPath, partialProgressPath(outputPath)]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Apply previously translated cue texts onto the in-memory cue list.
 * Returns how many cues were restored (have a non-null translation).
 */
export function applyResumedTranslations(
  cues: SubtitleCue[],
  translations: Array<string | null>,
): number {
  let restored = 0;
  const n = Math.min(cues.length, translations.length);
  for (let i = 0; i < n; i++) {
    const text = translations[i];
    if (typeof text !== "string") continue;
    const cue = cues[i];
    if (!cue?.data) continue;
    cue.data.translatedText = text;
    restored += 1;
  }
  return restored;
}

/** Snapshot current translatedText values for durable progress. */
export function snapshotTranslations(cues: SubtitleCue[]): Array<string | null> {
  return cues.map((cue) => {
    const t = cue?.data?.translatedText;
    return typeof t === "string" ? t : null;
  });
}

/** True when every cue in the chunk already has a translatedText string. */
export function chunkFullyTranslated(block: SubtitleCue[]): boolean {
  return block.length > 0 && block.every((cue) => typeof cue?.data?.translatedText === "string");
}
