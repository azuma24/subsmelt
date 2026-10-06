import { useCallback } from "react";
import type { TFunction } from "i18next";
import { getErrorMessage } from "../../lib";
import type { WhisperModel } from "../../types";
import type { ModelDownloadProgress } from "../../hooks";

export interface UseModelGateParams {
  whisperModels: WhisperModel[];
  modelsQuery: { isLoading: boolean; isError: boolean };
  modelDownloads: Record<string, ModelDownloadProgress>;
  downloadModel: (modelId: string) => Promise<void>;
  model: string;
  setModel: (modelId: string) => void;
  saveSetting: (key: string, value: string) => void;
  confirm: (opts: { title: string; message: string; confirmLabel?: string }) => Promise<boolean>;
  addToast: (message: string, type?: "success" | "error" | "info") => void;
  t: TFunction;
}

export interface UseModelGateResult {
  /** Look up downloaded status for a given model id from the cached models list. */
  isModelDownloaded: (modelId: string) => boolean | undefined;
  /**
   * Confirm-then-download for one model. Returns true only when the model ended
   * up downloaded. Shared by the picker and the pre-run gate so the confirm copy,
   * toasts and failure handling can't drift apart.
   */
  confirmAndDownload: (modelId: string) => Promise<boolean>;
  /**
   * Prompts the user to confirm a model download, then runs it.
   * Returns true when the model is ready (either was already downloaded, or
   * download confirmed+completed). Returns false when the user declines, the
   * models list hasn't loaded yet, or the model's runtime is missing.
   */
  ensureModelDownloaded: (modelId: string) => Promise<boolean>;
  /**
   * Handle model picker selection: if the chosen model is not downloaded,
   * prompt the user before committing the selection.
   */
  handleModelChange: (newModelId: string) => Promise<void>;
}

/**
 * Model-download gate for the Whisper run options: checks whether a model is
 * downloaded, and prompts + downloads it before it can be selected or used to
 * run a batch. Extracted from WhisperPage as a plain-params hook so the confirm
 * copy, toasts and failure handling stay in one place.
 */
export function useModelGate({
  whisperModels,
  modelsQuery,
  modelDownloads,
  downloadModel,
  model,
  setModel,
  saveSetting,
  confirm,
  addToast,
  t,
}: UseModelGateParams): UseModelGateResult {
  // Look up downloaded status for a given model id from the cached models list.
  const isModelDownloaded = useCallback(
    (modelId: string): boolean | undefined => {
      if (whisperModels.length === 0) return undefined; // list not loaded yet
      const entry = whisperModels.find((m) => m.id === modelId);
      if (!entry) return undefined; // model not in list
      return entry.downloaded;
    },
    [whisperModels],
  );

  const confirmAndDownload = useCallback(
    async (modelId: string): Promise<boolean> => {
      const entry = whisperModels.find((m) => m.id === modelId);
      const size = entry?.sizeMb;
      const message =
        typeof size === "number" && size > 0
          ? t("whisper.modelNotDownloadedMessage", { model: modelId, size: `${Math.round(size)} MB` })
          : t("whisper.modelNotDownloadedMessageNoSize", { model: modelId });

      const ok = await confirm({
        title: t("whisper.modelNotDownloadedTitle"),
        message,
        confirmLabel: t("settings.models.download"),
      });
      if (!ok) return false;

      try {
        addToast(t("whisper.modelDownloading", { model: modelId }), "info");
        await downloadModel(modelId);
        addToast(t("whisper.modelDownloadDone", { model: modelId }), "success");
        return true;
      } catch (e: unknown) {
        addToast(t("whisper.modelDownloadFailed", { model: modelId, message: getErrorMessage(e) }), "error");
        return false;
      }
    },
    [whisperModels, t, confirm, addToast, downloadModel],
  );

  const ensureModelDownloaded = useCallback(
    async (modelId: string): Promise<boolean> => {
      const entry = whisperModels.find((m) => m.id === modelId);
      if (entry?.available === false) {
        const reason = entry.unavailableReason ?? t("settings.models.runtimeMissing");
        addToast(t("stt.modelUnavailable", { model: entry.label ?? modelId, reason }), "error");
        return false;
      }
      const downloaded = isModelDownloaded(modelId);

      // Models list not loaded — don't let an unknown state slip through, and
      // say why the button did nothing.
      if (downloaded === undefined) {
        if (modelsQuery.isError) addToast(t("whisper.modelsLoadFailed"), "error");
        else if (modelsQuery.isLoading) addToast(t("whisper.modelsStillLoading"), "info");
        // List loaded fine but the saved model is not in it (deleted mid-session,
        // or a stale setting): say so instead of silently doing nothing.
        else addToast(t("whisper.modelNotListed"), "error");
        return false;
      }

      if (downloaded === true) return true;

      // Guard: if already downloading, don't stack a second dialog.
      if (modelDownloads[modelId]?.active) {
        return false;
      }

      return confirmAndDownload(modelId);
    },
    [
      whisperModels,
      isModelDownloaded,
      modelsQuery.isLoading,
      modelsQuery.isError,
      modelDownloads,
      addToast,
      t,
      confirmAndDownload,
    ],
  );

  // Handle model picker selection: if the chosen model is not downloaded,
  // prompt the user before committing the selection.
  const handleModelChange = useCallback(
    async (newModelId: string) => {
      const previousModel = model; // capture before any state change
      setModel(newModelId);

      if (isModelDownloaded(newModelId) === false) {
        // Guard: if already downloading this model, skip re-prompting.
        if (modelDownloads[newModelId]?.active) return;

        // Declining or a failed download both leave the model unusable — put the
        // picker back where it was rather than persisting a broken selection.
        if (!(await confirmAndDownload(newModelId))) {
          setModel(previousModel);
          return;
        }
      }
      saveSetting("transcription_model", newModelId);
    },
    [model, setModel, isModelDownloaded, modelDownloads, confirmAndDownload, saveSetting],
  );

  return { isModelDownloaded, confirmAndDownload, ensureModelDownloaded, handleModelChange };
}
