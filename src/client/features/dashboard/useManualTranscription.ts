import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { LIBRARY_QUERY_KEY, useMutationWithInvalidation, useSSE } from "../../hooks";
import { useToast } from "../../ui/Toast";
import type { ScanResult, TranscriptionHistoryEntry } from "../../types";
import {
  createManualTranscriptionProgress,
  isManualTranscriptionBusy,
  transitionManualTranscriptionProgress,
  type ManualTranscriptionProgress,
  type TranscribePostAction,
} from "./transcription-progress";

export interface UseManualTranscriptionResult {
  transcriptionProgressByPath: Record<string, ManualTranscriptionProgress>;
  transcribingPath: string | null;
  isTranscribePending: boolean;
  isRetryPending: boolean;
  handleTranscribe: (
    videoPath: string,
    postAction: TranscribePostAction,
    opts?: { skipRescan?: boolean },
  ) => Promise<void>;
  handleCancelTranscription: (videoPath: string) => Promise<void>;
  handleBatchTranscribe: (videoPaths: string[], postAction: TranscribePostAction) => Promise<void>;
  handleRetryTranscription: (attempt: TranscriptionHistoryEntry) => Promise<void>;
}

/**
 * Owns the manual transcription flow (single-file, batch, cancel, and
 * history retry) plus the per-path progress state machine. A finished
 * transcription changes the library (a new subtitle), so the hook writes the
 * server's fresh scan into the shared library cache, or refetches it.
 */
export function useManualTranscription(): UseManualTranscriptionResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const storeLibrary = (result: ScanResult | null | undefined) => {
    if (result?.files) queryClient.setQueryData(LIBRARY_QUERY_KEY, result);
    else void queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
  };
  const { addToast } = useToast();
  const [transcriptionProgressByPath, setTranscriptionProgressByPath] = useState<
    Record<string, ManualTranscriptionProgress>
  >({});
  const [transcribingPath, setTranscribingPath] = useState<string | null>(null);

  const transcribeMutation = useMutationWithInvalidation(
    (payload: { videoPath: string; postAction: TranscribePostAction }) => api.transcribeVideo(payload),
  );
  const retryTranscriptionMutation = useMutationWithInvalidation((id: string) => api.retryTranscriptionAttempt(id));
  const cancelTranscriptionMutation = useMutationWithInvalidation((videoPath: string) =>
    api.cancelTranscription({ path: videoPath }),
  );

  const updateTranscriptionProgress = (
    videoPath: string,
    updater: ManualTranscriptionProgress | ((current: ManualTranscriptionProgress) => ManualTranscriptionProgress),
  ) => {
    setTranscriptionProgressByPath((prev) => {
      const current = prev[videoPath];
      if (!current) return prev;
      const next =
        typeof updater === "function"
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

  const handleTranscribe = async (
    videoPath: string,
    postAction: TranscribePostAction,
    opts?: { skipRescan?: boolean },
  ) => {
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

      // A batch refreshes once after all files finish, instead of once per file.
      if (!opts?.skipRescan) storeLibrary(result.scanResult);
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
    // Skip files already transcribing so we don't clobber their live progress or
    // double-issue requests. Each file is isolated (handleTranscribe catches its
    // own errors), so one failure never aborts the rest.
    const runnable = videoPaths.filter((p) => !isManualTranscriptionBusy(transcriptionProgressByPath[p]));
    if (runnable.length === 0) return;
    for (const videoPath of runnable) {
      await handleTranscribe(videoPath, postAction, { skipRescan: true });
    }
    storeLibrary(null);
  };

  const handleRetryTranscription = async (attempt: TranscriptionHistoryEntry) => {
    setTranscribingPath(attempt.inputPath);
    try {
      const result = await retryTranscriptionMutation.mutateAsync(attempt.id);
      storeLibrary(result.scanResult);
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
