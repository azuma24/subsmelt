import type { ManualTranscriptionStage, TranscribePostAction } from "../../types";

export interface ManualTranscriptionProgress {
  postAction: TranscribePostAction;
  stage: ManualTranscriptionStage;
  message?: string;
  // Real per-segment completion percentage (0-100) sourced from the backend's
  // transcription:progress SSE events. Undefined until the first event arrives.
  pct?: number;
}

type ManualTranscriptionEvent =
  | { type: "preflight-passed" }
  | { type: "progress"; pct: number }
  | { type: "backend-finished" }
  | { type: "scan-queued" }
  | { type: "cancel-requested" }
  | { type: "cancelled" }
  | { type: "error"; message: string };

export function createManualTranscriptionProgress(postAction: TranscribePostAction): ManualTranscriptionProgress {
  return { postAction, stage: "preflighting" };
}

function isSkippedError(message: string): boolean {
  return /^Transcription skipped:/i.test(message.trim());
}

function isCancelledError(message: string): boolean {
  return /Transcription cancelled/i.test(message.trim());
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

// True while a transcription occupies its row (no terminal state reached yet).
export function isManualTranscriptionBusy(progress: ManualTranscriptionProgress | undefined): boolean {
  if (!progress) return false;
  return !["complete", "skipped", "failed", "cancelled"].includes(progress.stage);
}

export function transitionManualTranscriptionProgress(
  progress: ManualTranscriptionProgress,
  event: ManualTranscriptionEvent,
): ManualTranscriptionProgress {
  switch (event.type) {
    case "preflight-passed":
      return { ...progress, stage: "transcribing", message: undefined };
    case "progress":
      // Only meaningful while actively transcribing; ignore late events after
      // a terminal/cancelling transition so the bar does not jump backwards.
      if (progress.stage !== "transcribing") return progress;
      return { ...progress, pct: clampPct(event.pct) };
    case "backend-finished":
      return progress.postAction === "transcribe_and_translate"
        ? { ...progress, stage: "queueing", message: undefined, pct: 100 }
        : { ...progress, stage: "complete", message: undefined, pct: 100 };
    case "scan-queued":
      return { ...progress, stage: "complete", message: undefined, pct: 100 };
    case "cancel-requested":
      // Ignore once already settled.
      if (!isManualTranscriptionBusy(progress)) return progress;
      return { ...progress, stage: "cancelling", message: undefined };
    case "cancelled":
      return { ...progress, stage: "cancelled", message: undefined };
    case "error":
      return {
        ...progress,
        stage: isCancelledError(event.message)
          ? "cancelled"
          : isSkippedError(event.message)
            ? "skipped"
            : "failed",
        message: event.message,
      };
  }
}
