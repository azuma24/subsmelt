import type { ManualTranscriptionStage, TranscribePostAction } from "../../types";

export interface ManualTranscriptionProgress {
  postAction: TranscribePostAction;
  stage: ManualTranscriptionStage;
  message?: string;
}

type ManualTranscriptionEvent =
  | { type: "preflight-passed" }
  | { type: "backend-finished" }
  | { type: "scan-queued" }
  | { type: "error"; message: string };

export function createManualTranscriptionProgress(postAction: TranscribePostAction): ManualTranscriptionProgress {
  return { postAction, stage: "preflighting" };
}

function isSkippedError(message: string): boolean {
  return /^Transcription skipped:/i.test(message.trim());
}

export function transitionManualTranscriptionProgress(
  progress: ManualTranscriptionProgress,
  event: ManualTranscriptionEvent,
): ManualTranscriptionProgress {
  switch (event.type) {
    case "preflight-passed":
      return { ...progress, stage: "transcribing", message: undefined };
    case "backend-finished":
      return progress.postAction === "transcribe_and_translate"
        ? { ...progress, stage: "queueing", message: undefined }
        : { ...progress, stage: "complete", message: undefined };
    case "scan-queued":
      return { ...progress, stage: "complete", message: undefined };
    case "error":
      return {
        ...progress,
        stage: isSkippedError(event.message) ? "skipped" : "failed",
        message: event.message,
      };
  }
}
