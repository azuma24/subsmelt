import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { str } from "../../lib/settings-value";
import { useIsMobile, useJobsQuery, useMutationWithInvalidation, useSettingsQuery } from "../../hooks";
import { useToast } from "../../ui/Toast";
import { useConfirm } from "../../ui/ConfirmModal";
import type { Job } from "../../types";
import { ActionButton, EmptyHint, SelectionBar } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { JobsTableDesktop, JobsTableSkeleton } from "../dashboard/JobsTableDesktop";
import { JobCardMobile, JobCardSkeleton } from "../dashboard/JobCardMobile";
import { QueueToolbar } from "../dashboard/QueueToolbar";
import { useDashboardDerivedState } from "../dashboard/useDashboardDerivedState";
import type { JobStatusFilter } from "./dashboard-params";

interface JobsViewProps {
  status: JobStatusFilter;
  onStatusChange: (status: JobStatusFilter) => void;
  queueRunning: boolean;
  currentJobId: number | null;
  onPreview: (jobId: number) => void;
  onOpenDetails: (job: Job) => void;
  onOpenLogs: (jobId: number) => void;
}

/** Every job, including those with no Library file (Convert uploads), with the queue's bulk actions. */
export function JobsView({
  status,
  onStatusChange,
  queueRunning,
  currentJobId,
  onPreview,
  onOpenDetails,
  onOpenLogs,
}: JobsViewProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const jobsQuery = useJobsQuery();
  const settingsQuery = useSettingsQuery();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [folderFilter, setFolderFilter] = useState("all");
  const [targetFilter, setTargetFilter] = useState("all");

  const startSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.startQueue(ids));
  const clearJobsMutation = useMutationWithInvalidation(() => api.clearJobs());
  const deleteSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.deleteJobsApi(ids));
  const retrySelectedMutation = useMutationWithInvalidation((ids: number[]) => api.retryJobsApi(ids));
  const forceSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.forceJobsApi(ids));

  const jobs: Job[] = jobsQuery.data?.jobs || [];
  const mediaDir = str(settingsQuery.data?._media_dir, "/media");
  const {
    finishedJobCount,
    selectedPendingCount,
    selectedPendingIds,
    folderOptions,
    targetOptions,
    filteredJobs,
    visiblePendingIds,
    visibleErrorIds,
    visibleRetranslatableIds,
    hasQueueFilters,
    statusSegments,
  } = useDashboardDerivedState({
    jobs,
    mediaDir,
    statusFilter: status,
    folderFilter,
    targetFilter,
    selectedIds,
    t,
  });

  useEffect(() => {
    const pendingIdSet = new Set(jobs.filter((j) => j.status === "pending").map((j) => j.id));
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => pendingIdSet.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [jobs]);

  const reportFailure = (e: unknown) =>
    addToast(e instanceof Error ? e.message : t("dashboard.toast.actionFailed"), "error");

  const handleRunSelected = async () => {
    if (selectedPendingIds.length === 0) return;
    try {
      await startSelectedMutation.mutateAsync(selectedPendingIds);
      addToast(t("dashboard.toast.runSelectedStarted", { count: selectedPendingIds.length }), "info");
      setSelectedIds(new Set());
    } catch (e) {
      reportFailure(e);
    }
  };

  const handleClearFinished = async () => {
    const ok = await confirm({
      title: t("dashboard.confirm.clearTitle"),
      message: t("dashboard.confirm.clearMessage", { count: finishedJobCount }),
      confirmLabel: t("dashboard.confirm.clearConfirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      await clearJobsMutation.mutateAsync();
      setSelectedIds(new Set());
      addToast(t("dashboard.toast.jobsCleared"), "info");
    } catch (e) {
      reportFailure(e);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedPendingIds.length === 0) return;
    const ok = await confirm({
      title: t("dashboard.confirm.deleteSelectedTitle"),
      message: t("dashboard.confirm.deleteSelectedMessage", { count: selectedPendingIds.length }),
      confirmLabel: t("dashboard.confirm.deleteSelectedConfirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await deleteSelectedMutation.mutateAsync(selectedPendingIds);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of selectedPendingIds) next.delete(id);
        return next;
      });
      addToast(t("dashboard.toast.selectedDeleted", { count: result.deleted }), "info");
    } catch (e) {
      reportFailure(e);
    }
  };

  const handleRetryVisibleErrors = async () => {
    if (visibleErrorIds.length === 0) return;
    try {
      const result = await retrySelectedMutation.mutateAsync(visibleErrorIds);
      addToast(t("dashboard.toast.retrySelectedStarted", { count: result.updated }), "info");
    } catch (e) {
      reportFailure(e);
    }
  };

  const handleRetranslateVisible = async () => {
    if (visibleRetranslatableIds.length === 0) return;
    const ok = await confirm({
      title: t("dashboard.confirm.retranslateVisibleTitle"),
      message: t("dashboard.confirm.retranslateVisibleMessage", { count: visibleRetranslatableIds.length }),
      confirmLabel: t("dashboard.confirm.retranslateVisibleConfirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await forceSelectedMutation.mutateAsync(visibleRetranslatableIds);
      addToast(t("dashboard.toast.forceSelectedStarted", { count: result.updated }), "info");
    } catch (e) {
      reportFailure(e);
    }
  };

  const toggleSelectedJob = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const list = (() => {
    // Until the first /api/jobs response the list is unknown, not empty:
    // a skeleton or the failure, never the "no jobs" hint.
    if (jobsQuery.data === undefined && jobsQuery.isError) {
      return (
        <div className="p-4">
          <InlineError
            message={t("dashboard.queueLoadFailed", { message: getErrorMessage(jobsQuery.error) })}
            onRetry={() => void jobsQuery.refetch()}
          />
        </div>
      );
    }
    if (jobsQuery.data === undefined) {
      return isMobile ? (
        <div className="p-4">
          <JobCardSkeleton />
        </div>
      ) : (
        <JobsTableSkeleton />
      );
    }
    if (!isMobile) {
      return (
        <JobsTableDesktop
          jobs={filteredJobs}
          currentJobId={currentJobId}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          onPreview={onPreview}
          onOpenLogs={onOpenLogs}
          onOpenDetails={onOpenDetails}
        />
      );
    }
    return (
      <div className="space-y-2 p-4">
        {filteredJobs.length === 0 && (
          <EmptyHint text={t("dashboard.noJobsMatchFilter")} subtext={t("dashboard.emptyJobsHint")} />
        )}
        {filteredJobs.map((job) => (
          <JobCardMobile
            key={job.id}
            job={job}
            currentJobId={currentJobId}
            selected={selectedIds.has(job.id)}
            onToggleSelected={toggleSelectedJob}
            onPreview={onPreview}
            onOpenLogs={onOpenLogs}
            onOpenDetails={onOpenDetails}
          />
        ))}
      </div>
    );
  })();

  return (
    <section aria-label={t("library.view.jobs")} className="flex-1">
      <div
        role="group"
        aria-label={t("dashboard.filtersLabel")}
        className="flex gap-2 overflow-x-auto border-b border-border px-4 py-3"
      >
        {statusSegments.map((segment) => {
          const selected = segment.key === status;
          return (
            <button
              key={segment.key}
              type="button"
              aria-pressed={selected}
              onClick={() => onStatusChange(segment.key)}
              className={`inline-flex min-h-touch shrink-0 items-center gap-2 rounded-full border px-4 text-sm transition-colors duration-fast ${selected ? "border-text bg-text text-surface" : "border-border bg-surface text-text hover:bg-surface-raised"}`}
            >
              {segment.label}
              <span
                className={`font-mono text-xs tabular-nums ${selected ? "text-surface" : segment.count === 0 ? "text-muted" : segment.color}`}
              >
                {segment.count}
              </span>
            </button>
          );
        })}
      </div>
      <QueueToolbar
        hasQueueFilters={hasQueueFilters}
        folderFilter={folderFilter}
        targetFilter={targetFilter}
        folderOptions={folderOptions}
        targetOptions={targetOptions}
        onFolderFilterChange={setFolderFilter}
        onTargetFilterChange={setTargetFilter}
        onClearFilters={() => {
          onStatusChange("all");
          setFolderFilter("all");
          setTargetFilter("all");
        }}
        visiblePendingIds={visiblePendingIds}
        visibleErrorIds={visibleErrorIds}
        visibleRetranslatableIds={visibleRetranslatableIds}
        finishedJobCount={finishedJobCount}
        isRetryPending={retrySelectedMutation.isPending}
        isForcePending={forceSelectedMutation.isPending}
        onSelectVisiblePending={() => setSelectedIds((prev) => new Set([...prev, ...visiblePendingIds]))}
        onRetryVisibleErrors={handleRetryVisibleErrors}
        onRetranslateVisible={handleRetranslateVisible}
        onClearFinished={handleClearFinished}
        t={t}
      />
      <SelectionBar
        count={selectedPendingCount}
        summaryLabel={t("dashboard.selectionSummary", { count: selectedPendingCount })}
        hintLabel={t("dashboard.selectionHint")}
        onClear={() => setSelectedIds(new Set())}
        clearLabel={t("dashboard.clearSelection")}
      >
        {!queueRunning && (
          <ActionButton size="sm" variant="success" onClick={handleRunSelected} busy={startSelectedMutation.isPending}>
            {t("dashboard.runSelected", { count: selectedPendingCount })}
          </ActionButton>
        )}
        <ActionButton size="sm" variant="danger" onClick={handleDeleteSelected} busy={deleteSelectedMutation.isPending}>
          {t("dashboard.deleteSelected")}
        </ActionButton>
      </SelectionBar>
      {list}
    </section>
  );
}
