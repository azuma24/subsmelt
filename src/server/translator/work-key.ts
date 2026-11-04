import { createHash } from "node:crypto";
import fs from "node:fs";

/**
 * Identifies the work one job does: the source file's bytes plus what shapes the
 * translation (languages, prompt). Work saved under a key is reusable only while
 * the key still matches. A forced re-translate clears it. Null when the source cannot be read; the job then fails
 * with its usual error.
 */
export function workKey(srtPath: string, parts: readonly string[]): string | null {
  try {
    const hash = createHash("sha256").update(fs.readFileSync(srtPath));
    for (const part of parts) hash.update("\u0000").update(part);
    return hash.digest("hex");
  } catch {
    return null;
  }
}
