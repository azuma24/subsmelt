import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { LIBRARY_QUERY_KEY, useMutationWithInvalidation } from "../../hooks";
import { useToast } from "../../components/Toast";
import type { ScanResult } from "../../types";
import { summarizeScanFolders, type ScanPlan } from "./ScanConfirmModal";

/**
 * Scan = preview what would be queued, confirm, then run the scan that creates
 * jobs. Both responses are full library snapshots, so each one refreshes the
 * Library cache directly instead of triggering another preview request.
 */
export function useScanFlow() {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<ScanPlan | null>(null);
  const previewMutation = useMutationWithInvalidation(() => api.previewScan());
  const scanMutation = useMutationWithInvalidation(() => api.scanFolder());
  const store = (result: ScanResult) => queryClient.setQueryData(LIBRARY_QUERY_KEY, result);
  const fail = (e: unknown) => addToast(t("dashboard.toast.scanFailed", { message: getErrorMessage(e) }), "error");

  const start = async () => {
    try {
      const preview = await previewMutation.mutateAsync();
      store(preview);
      setPlan({ ...preview, topFolders: summarizeScanFolders(preview.files) });
    } catch (e) {
      fail(e);
    }
  };

  const confirm = async () => {
    try {
      const result = await scanMutation.mutateAsync();
      store(result);
      setPlan(null);
      addToast(t("dashboard.toast.scanComplete", { total: result.totalSubtitles, newJobs: result.newJobs }), "info");
    } catch (e) {
      fail(e);
    }
  };

  return {
    plan,
    busy: previewMutation.isPending || scanMutation.isPending,
    start,
    confirm,
    cancel: () => setPlan(null),
  };
}
