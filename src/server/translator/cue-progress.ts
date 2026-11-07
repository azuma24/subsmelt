import fs from "node:fs";
import { logger } from "../logger.js";
import { errorMessage } from "../errors.js";
import { writeFileAtomically } from "../shared-files.js";

/**
 * Which cues of a stopped job are really translated. The `.part` subtitle cannot
 * say: it shows the source text for a cue with no translation yet, so a translated
 * cue and an untranslated one look alike. This sidecar sits beside it, tied to the
 * job's work key, and goes away when the job finishes.
 */
const CUE_PROGRESS_SUFFIX = ".part.json";

interface StoredProgress {
  workKey: string;
  cues: Record<string, string>;
  /** Labels of the connections that translated them, since the job row is reset between runs. */
  connections?: string[];
}

export interface CueProgress {
  cues: Map<number, string>;
  connections: string[];
}

export function cueProgressPath(outputPath: string): string {
  return `${outputPath}${CUE_PROGRESS_SUFFIX}`;
}

export function removeCueProgress(outputPath: string): void {
  fs.rmSync(cueProgressPath(outputPath), { force: true });
  fs.rmSync(`${cueProgressPath(outputPath)}.tmp`, { force: true });
}

/** The translated cues saved for this exact work, by cue index. Anything else is discarded. */
export function loadCueProgress(outputPath: string, workKey: string): CueProgress {
  const file = cueProgressPath(outputPath);
  let stored: StoredProgress;
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    removeCueProgress(outputPath);
    return { cues: new Map(), connections: [] };
  }
  if (stored?.workKey !== workKey || typeof stored.cues !== "object" || stored.cues === null) {
    removeCueProgress(outputPath);
    return { cues: new Map(), connections: [] };
  }
  return {
    cues: new Map(
      Object.entries(stored.cues)
        .filter(([, text]) => typeof text === "string")
        .map(([index, text]) => [Number(index), text]),
    ),
    connections: Array.isArray(stored.connections)
      ? stored.connections.filter((label) => typeof label === "string")
      : [],
  };
}

/** Best-effort, like the `.part` save: a failure only means less to resume. Written whole, then renamed. */
export function saveCueProgress(
  outputPath: string,
  workKey: string,
  cues: ReadonlyMap<number, string>,
  connections: readonly string[] = [],
): void {
  const file = cueProgressPath(outputPath);
  try {
    const stored: StoredProgress = { workKey, cues: Object.fromEntries(cues), connections: [...connections] };
    writeFileAtomically(file, JSON.stringify(stored));
  } catch (error) {
    logger.warn("translate", `Could not save translation progress for ${outputPath}: ${errorMessage(error) || error}`);
  }
}
