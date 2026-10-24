import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { LIBRARY_QUERY_KEY } from "../../hooks";
import { useToast } from "../../ui/Toast";
import type { TranscriptionHistoryEntry } from "../../types";
import type { ManualTranscriptionProgress, TranscribePostAction } from "./transcription-progress";

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

/** Commands and observation only: the server owns every file in a batch. */
export function useManualTranscription(): UseManualTranscriptionResult {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["transcription-work"],
    queryFn: api.listTranscriptionWork,
    refetchInterval: 1500,
  });
  const items = query.data?.items ?? [];
  const active = items.filter((item) => item.status === "running" || item.status === "queued");
  const transcriptionProgressByPath: Record<string, ManualTranscriptionProgress> = {};
  for (const item of items.filter((entry) => entry.kind === "file")) {
    transcriptionProgressByPath[item.input] = {
      stage:
        item.status === "queued"
          ? "preflighting"
          : item.status === "running"
            ? "transcribing"
            : item.status === "succeeded"
              ? "complete"
              : item.status === "cancelled"
                ? "cancelled"
                : "failed",
      pct: item.progress,
      postAction:
        item.request?.postAction === "transcribe_and_translate" ? "transcribe_and_translate" : "transcribe_only",
      message: item.error,
    };
  }
  const submit = async (paths: string[], postAction: TranscribePostAction, extra: Record<string, unknown> = {}) => {
    try {
      await api.queueTranscriptionWork(
        paths.map((input) => ({ kind: "file", input, request: { postAction, ...extra } })),
      );
      void query.refetch();
    } catch (error) {
      addToast(t("dashboard.toast.transcriptionFailed", { message: getErrorMessage(error) }), "error");
    }
  };
  return {
    transcriptionProgressByPath,
    transcribingPath: active.find((item) => item.status === "running")?.input ?? null,
    isTranscribePending: active.length > 0,
    isRetryPending: false,
    handleTranscribe: (path, action) => submit([path], action),
    handleBatchTranscribe: (paths, action) => submit(paths, action),
    handleCancelTranscription: async (path) => {
      try {
        await Promise.all(
          active.filter((item) => item.input === path).map((item) => api.cancelTranscriptionWork(item.id)),
        );
        void query.refetch();
      } catch (error) {
        addToast(t("dashboard.toast.cancelFailed", { error: getErrorMessage(error) }), "error");
      }
    },
    handleRetryTranscription: async (attempt) => {
      await submit([attempt.inputPath], attempt.postAction, {
        outputFormat: attempt.outputFormat,
        model: attempt.model,
        language: attempt.language,
        device: attempt.device,
        computeType: attempt.computeType,
        advancedOptions: attempt.advancedOptions,
        overwrite: attempt.overwrite === true,
      });
      void client.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
    },
  };
}
