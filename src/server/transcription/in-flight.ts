// The one registry of transcription runs in flight, keyed by the id a run's
// progress events carry: the local media path, or the URL of a URL run. Each
// entry is the run's AbortController, which POST /api/transcribe/cancel aborts.
// At most one run per id: a second start is refused rather than letting both
// write the same subtitle and the second take over the first's cancel entry.
export const inFlightTranscriptions = new Map<string, AbortController>();

export class TranscriptionInFlightError extends Error {
  constructor(id: string) {
    super(`A transcription of this file is already running: ${id}`);
    this.name = "TranscriptionInFlightError";
  }
}

/** Registers a run, or throws TranscriptionInFlightError while another run holds the id. */
export function beginTranscriptionRun(id: string): AbortController {
  if (inFlightTranscriptions.has(id)) throw new TranscriptionInFlightError(id);
  const controller = new AbortController();
  inFlightTranscriptions.set(id, controller);
  return controller;
}

export function endTranscriptionRun(id: string, controller: AbortController): void {
  if (inFlightTranscriptions.get(id) === controller) inFlightTranscriptions.delete(id);
}

// A run the app gave up on (cancel, timeout, client hang-up) can keep the GPU
// busy until the backend notices the closed stream at its next step, and the
// JSON fallback routes never notice at all. The GPU gate counts such a run for
// this long after the app let go of it.
export const ABANDONED_RUN_GPU_HOLD_MS = 60_000;

let abandonedRuns = 0;

/** Counts an abandoned run for ABANDONED_RUN_GPU_HOLD_MS, then calls onReleased. */
export function holdGpuForAbandonedRun(onReleased: () => void, holdMs = ABANDONED_RUN_GPU_HOLD_MS): void {
  abandonedRuns += 1;
  const timer = setTimeout(() => {
    abandonedRuns -= 1;
    onReleased();
  }, holdMs);
  timer.unref();
}

/** Runs that may be using the GPU: in flight, or abandoned within the hold. */
export function gpuTranscriptionCount(): number {
  return inFlightTranscriptions.size + abandonedRuns;
}
