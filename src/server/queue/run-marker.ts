import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { errorMessage } from "../errors.js";

/**
 * The queue run the user started, kept on disk until it finishes or is
 * stopped. A process that dies mid-run never clears it, so the next process
 * finds it and resumes the run even with auto-translate off. `ids` lists the
 * selected jobs, or is null for a run of all pending jobs.
 */
interface QueueRunMarker {
  ids: number[] | null;
}

const MARKER_FILE = path.join(process.env.DATA_DIR || "./data", "queue-run.json");

/** The run a previous process left unfinished, or null when none was. */
export function interruptedQueueRun(): QueueRunMarker | null {
  try {
    const marker = JSON.parse(fs.readFileSync(MARKER_FILE, "utf8")) as QueueRunMarker;
    if (marker.ids === null) return { ids: null };
    return Array.isArray(marker.ids) && marker.ids.every(Number.isSafeInteger) ? { ids: marker.ids } : null;
  } catch {
    return null;
  }
}

/**
 * Records a requested run, widening one already recorded the way a live run
 * widens. A failed write only costs the resume after a crash, so the run
 * still starts.
 */
export function markQueueRun(ids: number[] | undefined): void {
  const current = interruptedQueueRun();
  const merged = !ids || current?.ids === null ? null : [...new Set([...(current?.ids ?? []), ...ids])];
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
    const tmp = `${MARKER_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ids: merged } satisfies QueueRunMarker));
    fs.renameSync(tmp, MARKER_FILE);
  } catch (error) {
    logger.warn("queue", `Could not record the queue run for restart: ${errorMessage(error)}`);
  }
}

export function clearQueueRun(): void {
  fs.rmSync(MARKER_FILE, { force: true });
}
