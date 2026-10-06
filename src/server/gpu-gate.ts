import { getSetting } from "./config.js";
import { countPendingJobs } from "./db.js";
import { gpuTranscriptionCount } from "./transcription/in-flight.js";

/** Subtitles waiting for translation that open the gate even while YouTube videos still wait for Whisper. */
export const SUBTITLES_WAITING_CAP = 20;

export interface GpuState {
  /** The gpu_shared setting: Whisper and the translation model share one GPU. */
  shared: boolean;
  transcriptionsRunning: number;
  /** YouTube videos that will still need Whisper: queued (outside a cooldown), downloading or transcribing. */
  youtubeBacklog: number;
  /** Translation jobs waiting to start. */
  subtitlesWaiting: number;
}

export type TranslationGate = { open: true } | { open: false; waitingFor: number };

/**
 * Batch mode. Translation starts once no transcription runs and no YouTube
 * video still needs Whisper, so the model swaps twice per batch rather than
 * twice per video. 20 waiting subtitles cap the wait: the gate then opens
 * after the current transcription, however many videos are pending.
 */
export function translationGate(state: GpuState): TranslationGate {
  if (!state.shared) return { open: true };
  if (state.transcriptionsRunning > 0) return { open: false, waitingFor: Math.max(state.transcriptionsRunning, state.youtubeBacklog) };
  if (state.youtubeBacklog > 0 && state.subtitlesWaiting < SUBTITLES_WAITING_CAP) return { open: false, waitingFor: state.youtubeBacklog };
  return { open: true };
}

/** A translation batch already running finishes first; it is never aborted for Whisper. */
export function transcriptionMayStart(shared: boolean, translationRunning: boolean): boolean {
  return !shared || !translationRunning;
}

export function gpuShared(): boolean {
  return getSetting("gpu_shared") === "1";
}

/** How often a transcription waiting for the GPU checks the translation batch again. */
export const GPU_WAIT_POLL_MS = 2_000;

/**
 * Resolves once a transcription may start: at once without a shared GPU or a
 * running batch, else when the batch has finished. onWaiting runs once if the
 * run has to wait. Aborting the signal rejects with "Transcription cancelled".
 */
export async function waitUntilTranscriptionMayStart(
  translationRunning: () => boolean,
  signal: AbortSignal,
  onWaiting?: () => void,
  pollMs = GPU_WAIT_POLL_MS,
): Promise<void> {
  let announced = false;
  while (!transcriptionMayStart(gpuShared(), translationRunning())) {
    if (signal.aborted) throw new Error("Transcription cancelled");
    if (!announced) {
      announced = true;
      onWaiting?.();
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollMs);
      signal.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
  }
  if (signal.aborted) throw new Error("Transcription cancelled");
}

let youtubeBacklog: () => number = () => 0;

/** The YouTube worker reports how many videos still need Whisper. */
export function setYoutubeBacklogSource(source: () => number): void {
  youtubeBacklog = source;
}

export function currentGpuState(): GpuState {
  return {
    shared: gpuShared(),
    transcriptionsRunning: gpuTranscriptionCount(),
    youtubeBacklog: youtubeBacklog(),
    subtitlesWaiting: countPendingJobs(),
  };
}

export function currentTranslationGate(): TranslationGate {
  return translationGate(currentGpuState());
}

// A start the gate refused: all pending jobs, or the ids a Run asked for.
let held: { ids: number[] | undefined } | null = null;

/** Remembers a refused start. Two held starts merge; one for all jobs covers any subset. */
export function holdQueueStart(ids: number[] | undefined): void {
  if (!held) held = { ids };
  else if (!held.ids || !ids) held = { ids: undefined };
  else held = { ids: [...new Set([...held.ids, ...ids])] };
}

/** Takes the held start once the gate is open; null while it stays closed or nothing was held. */
export function takeHeldStart(): { ids: number[] | undefined } | null {
  if (!held || !currentTranslationGate().open) return null;
  const start = held;
  held = null;
  return start;
}

export function isQueueStartHeld(): boolean {
  return held !== null;
}
