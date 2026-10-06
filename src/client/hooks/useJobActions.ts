import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api";
import { useMutationWithInvalidation } from "./mutations";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmModal";
import { classifyErrorReason } from "../features/dashboard/job-actions";

// Single source of truth for per-job actions shared by JobsTableDesktop and
// JobCardMobile. Each action wraps the matching API mutation
// with the consistent toast + error handling the rest of the app uses, and the
// destructive single delete is routed through the shared confirm modal.

interface UseJobActionsOptions {
  // Called after a job is successfully deleted so the caller can drop it from any
  // local selection state. Optional because not every surface tracks selection.
  onDeleted?: (id: number) => void;
}

export interface JobActions {
  retry: (id: number) => void;
  retranslate: (id: number) => void;
  cancel: (id: number) => void;
  pin: (id: number) => void;
  unpin: (id: number) => void;
  // Confirms before deleting; resolves when the flow settles (cancel or done).
  remove: (id: number) => Promise<void>;
  classifyErrorReason: (error: string | null) => string;
  // True while the corresponding mutation is in flight, so buttons can be
  // disabled to prevent double-fire.
  isRetrying: boolean;
  isRetranslating: boolean;
  isCancelling: boolean;
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
  const cancelMutation = useMutationWithInvalidation((id: number) => api.cancelJob(id));
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
    [retryMutation.mutate, retryMutation.isPending, addToast, t, showError]
  );

  const retranslate = useCallback(
    (id: number) => {
      forceMutation.mutate(id, {
        onSuccess: () => addToast(t("dashboard.toast.retranslating"), "info"),
        onError: () => showError("dashboard.toast.actionFailed"),
      });
    },
    [forceMutation.mutate, forceMutation.isPending, addToast, t, showError]
  );

  const cancel = useCallback(
    (id: number) => {
      cancelMutation.mutate(id, {
        onSuccess: () => addToast(t("dashboard.toast.jobCancelled"), "info"),
        onError: () => showError("dashboard.toast.actionFailed"),
      });
    },
    [cancelMutation.mutate, cancelMutation.isPending, addToast, t, showError]
  );

  const pin = useCallback(
    (id: number) => {
      pinMutation.mutate(id, { onError: () => showError("dashboard.toast.actionFailed") });
    },
    [pinMutation.mutate, pinMutation.isPending, showError]
  );

  const unpin = useCallback(
    (id: number) => {
      unpinMutation.mutate(id, { onError: () => showError("dashboard.toast.actionFailed") });
    },
    [unpinMutation.mutate, unpinMutation.isPending, showError]
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
    [confirm, deleteMutation.mutate, deleteMutation.isPending, onDeleted, addToast, t, showError]
  );

  // A stable identity between renders: memoized job rows compare this object,
  // so a fresh object per render would make the memo decorative. The deps use
  // `mutate` (stable per mutation) and the isPending flags — the mutation
  // result object itself is fresh on every render.
  return useMemo(
    () => ({
      retry,
      retranslate,
      cancel,
      pin,
      unpin,
      remove,
      classifyErrorReason,
      isRetrying: retryMutation.isPending,
      isRetranslating: forceMutation.isPending,
      isCancelling: cancelMutation.isPending,
      isPinning: pinMutation.isPending,
      isUnpinning: unpinMutation.isPending,
      isDeleting: deleteMutation.isPending,
    }),
    [retry, retranslate, cancel, pin, unpin, remove, retryMutation.isPending, forceMutation.isPending, cancelMutation.isPending, pinMutation.isPending, unpinMutation.isPending, deleteMutation.isPending],
  );
}
