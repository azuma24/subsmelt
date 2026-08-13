import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api";
import { useMutationWithInvalidation } from "../hooks";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmModal";
import { classifyErrorReason } from "../features/dashboard/job-actions";

// Single source of truth for per-job actions shared by JobsTableDesktop and
// JobCardMobile (frontend-audit §9). Each action wraps the matching API mutation
// with the consistent toast + error handling the rest of the app uses, and the
// destructive single delete is routed through the shared confirm modal
// (frontend-audit §11).

interface UseJobActionsOptions {
  // Called after a job is successfully deleted so the caller can drop it from any
  // local selection state. Optional because not every surface tracks selection.
  onDeleted?: (id: number) => void;
}

export interface JobActions {
  retry: (id: number) => void;
  retranslate: (id: number) => void;
  pin: (id: number) => void;
  unpin: (id: number) => void;
  // Confirms before deleting; resolves when the flow settles (cancel or done).
  remove: (id: number) => Promise<void>;
  classifyErrorReason: (error: string | null) => string;
  // True while the corresponding mutation is in flight, so buttons can be
  // disabled to prevent double-fire (frontend-audit §11).
  isRetrying: boolean;
  isRetranslating: boolean;
  isPinning: boolean;
  isUnpinning: boolean;
  isDeleting: boolean;
}

export function useJobActions(options: UseJobActionsOptions = {}): JobActions {
  const { onDeleted } = options;
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const showError = useCallback(
    (key: string) => addToast(t(key), "error"),
    [addToast, t]
  );

  const retryMutation = useMutationWithInvalidation((id: number) => api.retryJob(id));
  const forceMutation = useMutationWithInvalidation((id: number) => api.forceJob(id));
  const pinMutation = useMutationWithInvalidation((id: number) => api.pinJob(id));
  const unpinMutation = useMutationWithInvalidation((id: number) => api.unpinJob(id));
  const deleteMutation = useMutationWithInvalidation((id: number) => api.deleteJobApi(id));

  const retry = useCallback(
    (id: number) => {
      retryMutation.mutate(id, {
        onSuccess: () => addToast(t("dashboard.toast.jobRetrying"), "info"),
        onError: () => showError("dashboard.toast.actionFailed"),
      });
    },
    [retryMutation, addToast, t, showError]
  );

  const retranslate = useCallback(
    (id: number) => {
      forceMutation.mutate(id, {
        onSuccess: () => addToast(t("dashboard.toast.retranslating"), "info"),
        onError: () => showError("dashboard.toast.actionFailed"),
      });
    },
    [forceMutation, addToast, t, showError]
  );

  const pin = useCallback(
    (id: number) => {
      pinMutation.mutate(id, { onError: () => showError("dashboard.toast.actionFailed") });
    },
    [pinMutation, showError]
  );

  const unpin = useCallback(
    (id: number) => {
      unpinMutation.mutate(id, { onError: () => showError("dashboard.toast.actionFailed") });
    },
    [unpinMutation, showError]
  );

  const remove = useCallback(
    async (id: number) => {
      const ok = await confirm({
        title: t("dashboard.confirm.deleteJobTitle"),
        message: t("dashboard.confirm.deleteJobMessage"),
        confirmLabel: t("dashboard.confirm.deleteJobConfirm"),
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteMutation.mutateAsync(id);
        onDeleted?.(id);
        addToast(t("dashboard.toast.jobDeleted"), "info");
      } catch {
        showError("dashboard.toast.deleteFailed");
      }
    },
    [confirm, deleteMutation, onDeleted, addToast, t, showError]
  );

  return {
    retry,
    retranslate,
    pin,
    unpin,
    remove,
    classifyErrorReason,
    isRetrying: retryMutation.isPending,
    isRetranslating: forceMutation.isPending,
    isPinning: pinMutation.isPending,
    isUnpinning: unpinMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}
