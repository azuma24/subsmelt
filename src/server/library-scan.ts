import { getAllSettings, getSetting } from "./config.js";
import { logger } from "./logger.js";
import { runQueueSafely } from "./queue.js";
import { getTranscriptionBackendUrl } from "./routes/transcription.js";
import { scanFolder, type ScanResult } from "./scanner.js";
import { readSettings } from "./settings-schema.js";
import { broadcast } from "./sse.js";
import { enqueueIntakeTranscripts, enqueueMissingTranscripts } from "./transcription/scheduled.js";

type ScanTrigger = "full" | "watcher" | "poll";
let inFlight: { trigger: ScanTrigger; result: Promise<ScanResult> } | null = null;

export async function scanAndEnqueue(trigger: ScanTrigger = "full", signal?: AbortSignal): Promise<ScanResult> {
  // A watcher event can refer to a file created after the current walk passed
  // its directory. Reconcile it after that walk instead of losing the event.
  signal?.throwIfAborted();
  while (inFlight) {
    if (trigger === "poll" || (trigger === "full" && inFlight.trigger !== "watcher")) return inFlight.result;
    await inFlight.result.catch(() => {});
    signal?.throwIfAborted();
    // File signals waiting on the same walk can share the next pass.
    if (trigger === "watcher" && inFlight) return inFlight.result;
  }
  const result = runScan(trigger);
  inFlight = { trigger, result };
  try {
    return await result;
  } finally {
    inFlight = null;
  }
}

async function runScan(trigger: ScanTrigger): Promise<ScanResult> {
  const typed = readSettings();
  const transcriptionAvailable = typed.transcription_enabled && Boolean(getTranscriptionBackendUrl(getAllSettings()));
  const result = await scanFolder(true, { intake: "run", transcriptionAvailable });
  if (result.complete && transcriptionAvailable) {
    enqueueMissingTranscripts(result, typed.transcription_missing_subtitle_behavior);
    await enqueueIntakeTranscripts(result);
  }
  if (result.newJobs > 0 && getSetting("auto_translate") === "1") setTimeout(() => runQueueSafely(), 100);
  broadcast("scan:complete", {
    newJobs: result.newJobs,
    total: result.totalSubtitles,
    complete: result.complete,
    errors: result.errors,
  });
  if (trigger === "watcher") {
    for (const error of result.errors) {
      logger.warn("scan", `Watcher scan could not read ${error.path}: ${error.message}`);
    }
    if (result.newJobs > 0) logger.info("scan", `Watcher: ${result.newJobs} new jobs queued`);
  }
  return result;
}

export function previewLibraryScan(): Promise<ScanResult> {
  const transcriptionAvailable =
    getSetting("transcription_enabled") === "1" && Boolean(getTranscriptionBackendUrl(getAllSettings()));
  return scanFolder(false, { intake: "preview", transcriptionAvailable });
}
