import { getAllSettings, getSetting } from "./config.js";
import { logger } from "./logger.js";
import { runQueueSafely } from "./queue.js";
import { getTranscriptionBackendUrl } from "./routes/transcription.js";
import { scanFolder, type ScanResult } from "./scanner.js";
import { readSettings } from "./settings-schema.js";
import { broadcast } from "./sse.js";
import { enqueueIntakeTranscripts, enqueueMissingTranscripts } from "./transcription/scheduled.js";

type ScanTrigger = "full" | "watcher" | "poll";
let inFlight: { trigger: ScanTrigger; signal?: AbortSignal; result: Promise<ScanResult> } | null = null;

export async function scanAndEnqueue(trigger: ScanTrigger = "full", signal?: AbortSignal): Promise<ScanResult> {
  signal?.throwIfAborted();
  // An event may refer to a file behind the current walk. Let the first
  // waiter start a follow-up and share it with events waiting on that walk.
  let needsFollowUp = trigger === "watcher";
  while (inFlight) {
    const current = inFlight;
    // A manual scan must survive pausing either automatic source.
    const share = trigger === "full" ? current.trigger === "full" : !needsFollowUp;
    try {
      const result = await current.result;
      if (share) return result;
    } catch (error) {
      if (share && !current.signal?.aborted) throw error;
    }
    signal?.throwIfAborted();
    needsFollowUp = false;
  }
  const result = runScan(trigger, signal);
  inFlight = { trigger, signal, result };
  try {
    return await result;
  } finally {
    inFlight = null;
  }
}

async function runScan(trigger: ScanTrigger, signal?: AbortSignal): Promise<ScanResult> {
  const typed = readSettings();
  const transcriptionAvailable = typed.transcription_enabled && Boolean(getTranscriptionBackendUrl(getAllSettings()));
  const result = await scanFolder(true, { intake: "run", transcriptionAvailable, signal });
  // These translation jobs are committed. Let them run even if the watcher
  // is paused during the remaining subtitle checks.
  if (result.newJobs > 0 && getSetting("auto_translate") === "1") setTimeout(() => runQueueSafely(), 100);
  try {
    if (result.complete && transcriptionAvailable) {
      await enqueueMissingTranscripts(result, typed.transcription_missing_subtitle_behavior, {
        requireSettled: trigger !== "full",
        signal,
      });
      await enqueueIntakeTranscripts(result, signal);
    }
    return result;
  } finally {
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
  }
}

export function previewLibraryScan(): Promise<ScanResult> {
  const transcriptionAvailable =
    getSetting("transcription_enabled") === "1" && Boolean(getTranscriptionBackendUrl(getAllSettings()));
  return scanFolder(false, { intake: "preview", transcriptionAvailable });
}
