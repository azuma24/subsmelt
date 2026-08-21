import { useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useMutationWithInvalidation, useSSE } from "../../hooks";
import { useToast } from "../../components/Toast";
import type { ScannedFile, ScanResult, TranscriptionHistoryEntry } from "../../types";
import {
  createManualTranscriptionProgress,
  isManualTranscriptionBusy,
  transitionManualTranscriptionProgress,
  type ManualTranscriptionProgress,
  type TranscribePostAction,
} from "./transcription-progress";

export type ScanResultMode = "preview" | "queued";

export interface UseManualTranscriptionOptions {
  setScanResult: Dispatch<SetStateAction<ScannedFile[] | null>>;
  setScanResultMode: Dispatch<SetStateAction<ScanResultMode>>;
  setSelectedVideoPaths: Dispatch<SetStateAction<Set<string>>>;
  // Re-runs the scan preview so the file/subtitle list reflects a subtitle
  // that manual transcription just produced. Injected rather than owned here
  // so this hook shares the same mutation instance (and pending state) the
  // page's own preview/scan buttons use.
  refreshScanPreview: () => Promise<ScanResult>;
}

export interface UseManualTranscriptionResult {
  transcriptionProgressByPath: Record<string, ManualTranscriptionProgress>;
  transcribingPath: string | null;
  isTranscribePending: boolean;
  isRetryPending: boolean;
  handleTranscribe: (videoPath: string, postAction: TranscribePostAction, opts?: { skipRescan?: boolean }) => Promise<void>;
  handleCancelTranscription: (videoPath: string) => Promise<void>;
  handleBatchTranscribe: (videoPaths: string[], postAction: TranscribePostAction) => Promise<void>;
  handleRetryTranscription: (attempt: TranscriptionHistoryEntry) => Promise<void>;
}

/**
 * Owns the manual transcription flow (single-file, batch, cancel, and
 * history retry) plus the per-path progress state machine that drives the
 * scan-results UI. Scan-result state itself stays with the page since it is
 * also written by the unrelated preview/scan/clear handlers; this hook is
 * handed setters for it and a shared scan-preview refresher instead of
 * owning that state.
 */
export function useManualTranscription({
  setScanResult,
  setScanResultMode,
  setSelectedVideoPaths,
  refreshScanPreview,
}: UseManualTranscriptionOptions): UseManualTranscriptionResult {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [transcriptionProgressByPath, setTranscriptionProgressByPath] = useState<Record<string, ManualTranscriptionProgress>>({});
  const [transcribingPath, setTranscribingPath] = useState<string | null>(null);

  const transcribeMutation = useMutationWithInvalidation((payload: { videoPath: string; postAction: TranscribePostAction }) => api.transcribeVideo(payload));
  const retryTranscriptionMutation = useMutationWithInvalidation((id: string) => api.retryTranscriptionAttempt(id));
  const cancelTranscriptionMutation = useMutationWithInvalidation((videoPath: string) => api.cancelTranscription({ path: videoPath }));

  const updateTranscriptionProgress = (
    videoPath: string,
    updater: ManualTranscriptionProgress | ((current: ManualTranscriptionProgress) => ManualTranscriptionProgress),
  ) => {
    setTranscriptionProgressByPath((prev) => {
      const current = prev[videoPath];
      if (!current) return prev;
      const next = typeof updater === "function"
        ? (updater as (current: ManualTranscriptionProgress) => ManualTranscriptionProgress)(current)
        : updater;
      return { ...prev, [videoPath]: next };
    });
  };

  // Subscribe to live per-segment transcription progress. The backend emits
  // transcription:progress { path, pct, processedSeconds, totalSeconds } as it
  // processes the faster-whisper segment generator; we match by path and feed
  // the real percentage into the progress state machine.
  useSSE((type, data) => {
    if (type !== "transcription:progress") return;
    const videoPath = typeof data.path === "string" ? data.path : "";
    if (!videoPath) return;
    if (data.cancelled === true) {
      updateTranscriptionProgress(videoPath, (current) =>
        transitionManualTranscriptionProgress(current, { type: "cancelled" }),
      );
      return;
    }
    if (typeof data.pct === "number") {
      const pct = data.pct;
      updateTranscriptionProgress(videoPath, (current) =>
        transitionManualTranscriptionProgress(current, { type: "progress", pct }),
      );
    }
  });

  const handleCancelTranscription = async (videoPath: string) => {
    updateTranscriptionProgress(videoPath, (current) =>
      transitionManualTranscriptionProgress(current, { type: "cancel-requested" }),
    );
    try {
      await cancelTranscriptionMutation.mutateAsync(videoPath);
    } catch (e: unknown) {
      addToast(t("dashboard.toast.cancelFailed", { error: getErrorMessage(e) }), "error");
    }
  };

  const handleTranscribe = async (videoPath: string, postAction: TranscribePostAction, opts?: { skipRescan?: boolean }) => {
    setTranscriptionProgressByPath((prev) => ({
      ...prev,
      [videoPath]: createManualTranscriptionProgress(postAction),
    }));
    try {
      await api.preflightTranscription({ videoPath, postAction });
      updateTranscriptionProgress(videoPath, (current) =>
        transitionManualTranscriptionProgress(current, { type: "preflight-passed" }),
      );

      const result = await transcribeMutation.mutateAsync({ videoPath, postAction });
      if (postAction === "transcribe_and_translate") {
        updateTranscriptionProgress(videoPath, (current) =>
          transitionManualTranscriptionProgress(current, { type: "backend-finished" }),
        );
      }

      // In batch mode the caller does a single rescan after all files finish —
      // skip the per-file refresh (avoids N scans + N re-renders mid-batch).
      if (opts?.skipRescan) {
        // no-op: leave scan state for the batch caller to refresh once
      } else if (result.scanResult?.files) {
        setScanResult(result.scanResult.files);
        setScanResultMode(postAction === "transcribe_and_translate" ? "queued" : "preview");
      } else {
        const refreshed = await refreshScanPreview();
        setScanResult(refreshed.files);
        setScanResultMode("preview");
      }
      updateTranscriptionProgress(videoPath, (current) =>
        transitionManualTranscriptionProgress(
          current,
          postAction === "transcribe_and_translate" ? { type: "scan-queued" } : { type: "backend-finished" },
        ),
      );
      addToast(
        postAction === "transcribe_and_translate"
          ? t("dashboard.toast.transcriptionCompleteQueued")
          : t("dashboard.toast.transcriptionCompleteGenerated"),
        "success",
      );
    } catch (e: unknown) {
      const message = getErrorMessage(e);
      updateTranscriptionProgress(videoPath, (current) =>
        transitionManualTranscriptionProgress(current, { type: "error", message }),
      );
      addToast(t("dashboard.toast.transcriptionFailed", { message }), "error");
    }
  };

  // Batch transcription: run the same single-file flow for each selected video,
  // sequentially so per-file progress is visible and the server's transcription
  // semaphore still bounds concurrency. Reuses handleTranscribe wholesale.
  const handleBatchTranscribe = async (videoPaths: string[], postAction: TranscribePostAction) => {
    setSelectedVideoPaths(new Set());
    // Skip files already transcribing so we don't clobber their live progress or
    // double-issue requests. Each file is isolated (handleTranscribe catches its
    // own errors), so one failure never aborts the rest.
    const runnable = videoPaths.filter((p) => !isManualTranscriptionBusy(transcriptionProgressByPath[p]));
    if (runnable.length === 0) return;
    for (const videoPath of runnable) {
      await handleTranscribe(videoPath, postAction, { skipRescan: true });
    }
    // One scan refresh after the whole batch (instead of one per file).
    try {
      const refreshed = await refreshScanPreview();
      setScanResult(refreshed.files);
      setScanResultMode(postAction === "transcribe_and_translate" ? "queued" : "preview");
    } catch {
      // Non-fatal: transcription already completed; the next manual scan will sync.
    }
  };

  const handleRetryTranscription = async (attempt: TranscriptionHistoryEntry) => {
    setTranscribingPath(attempt.inputPath);
    try {
      const result = await retryTranscriptionMutation.mutateAsync(attempt.id);
      if (result.scanResult?.files) {
        setScanResult(result.scanResult.files);
        setScanResultMode(attempt.postAction === "transcribe_and_translate" ? "queued" : "preview");
      }
      addToast(t("dashboard.toast.transcriptionRetried"), "success");
    } catch (e: unknown) {
      addToast(t("dashboard.toast.retryFailed", { error: getErrorMessage(e) }), "error");
    } finally {
      setTranscribingPath(null);
    }
  };

  return {
    transcriptionProgressByPath,
    transcribingPath,
    isTranscribePending: transcribeMutation.isPending,
    isRetryPending: retryTranscriptionMutation.isPending,
    handleTranscribe,
    handleCancelTranscription,
    handleBatchTranscribe,
    handleRetryTranscription,
  };
}
