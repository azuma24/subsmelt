import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { parentFolderLabel, useDashboardDerivedState } from "../dashboard/useDashboardDerivedState";
import { folderInScope } from "./folder-scope";
import type { JobStatusFilter } from "./dashboard-params";
import type { UseManualTranscriptionResult } from "../dashboard/useManualTranscription";
import { Icon } from "../../ui/Icon";
import { useLibraryQuery } from "../../hooks";
import { FileCardMobile, FileRowDesktop } from "./FileRows";
import { LibraryPanel } from "./LibraryPanel";
import { LibraryEmpty } from "./LibraryStates";
import type { LibraryItem } from "./library-model";
import { useLibraryFiles } from "./useLibraryFiles";
import type { RowLayout } from "./dashboard-params";
import { fileEntries, fileFilterOptions, fileMatchesFilters, fileMatchesStatus } from "./file-entries";
import { FileList } from "./FileList";

interface JobsViewProps {
  status: JobStatusFilter;
  onStatusChange: (status: JobStatusFilter) => void;
  /** One row per job, or one per Library file with its language chips. */
  rows: RowLayout;
  onRowsChange: (rows: RowLayout) => void;
  /** The folder shown with its subfolders ("all" for everything), kept in the URL by the page. */
  folder: string;
  onFolderChange: (folder: string) => void;
  queueRunning: boolean;
  currentJobId: number | null;
  onPreview: (jobId: number) => void;
  onOpenDetails: (job: Job) => void;
  onOpenLogs: (jobId: number) => void;
  /** Library files, for the rows of work with no job yet and the per-file panel. */
  items: LibraryItem[];
  transcription: UseManualTranscriptionResult;
  transcriptionEnabled: boolean;
  onOpenJob: (jobId: number) => void;
}

/**
 * The Library's main view: every job (Convert uploads included), plus the
 * Library files with no job yet — videos waiting for a transcription and
 * languages never queued — with search, filters and the queue's bulk actions.
 * A file name opens that file's panel.
 */
export function JobsView({
  status,
  onStatusChange,
  rows,
  onRowsChange,
  folder: folderFilter,
  onFolderChange: setFolderFilter,
  queueRunning,
  currentJobId,
  onPreview,
  onOpenDetails,
  onOpenLogs,
  items,
  transcription,
  transcriptionEnabled,
  onOpenJob,
}: JobsViewProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const jobsQuery = useJobsQuery();
  const settingsQuery = useSettingsQuery();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [targetFilter, setTargetFilter] = useState("all");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const libraryQuery = useLibraryQuery();

  const startSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.startQueue(ids));
  const clearJobsMutation = useMutationWithInvalidation((ids: number[] | undefined) => api.clearJobs(ids));
  const deleteSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.deleteJobsApi(ids));
  const retrySelectedMutation = useMutationWithInvalidation((ids: number[]) => api.retryJobsApi(ids));
  const forceSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.forceJobsApi(ids));

  const allJobs: Job[] = useMemo(() => jobsQuery.data?.jobs || [], [jobsQuery.data]);
  const mediaDir = str(settingsQuery.data?._media_dir, "/media");
  // The folder chosen in the sidebar narrows everything below it: the rows, the
  // status counts, the filter options and what the bulk actions act on.
  const rootFolderLabel = t("dashboard.folderRoot");
  const externalFolderLabel = t("dashboard.folderExternal");
  const jobs = useMemo(
    () =>
      allJobs.filter((job) =>
        folderInScope(
          parentFolderLabel(job.srt_path, mediaDir, rootFolderLabel, externalFolderLabel),
          folderFilter,
          rootFolderLabel,
          externalFolderLabel,
        ),
      ),
    [allJobs, mediaDir, folderFilter, rootFolderLabel, externalFolderLabel],
  );
  const folderItems = useMemo(
    () => items.filter((item) => folderInScope(item.folder || rootFolderLabel, folderFilter, rootFolderLabel)),
    [items, folderFilter, rootFolderLabel],
  );
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
    query,
    selectedIds,
    t,
  });
  const jobsById = useMemo(() => new Map(allJobs.map((job) => [job.id, job])), [allJobs]);
  const files = useLibraryFiles({
    items: folderItems,
    jobsById,
    status,
    query,
    folderFilter,
    targetFilter,
    rootLabel: t("dashboard.folderRoot"),
    transcription,
    transcriptionEnabled,
  });
  const rootLabel = t("dashboard.folderRoot");
  const entries = useMemo(() => fileEntries(folderItems, jobsById), [folderItems, jobsById]);
  const entryOptions = useMemo(() => fileFilterOptions(entries, rootLabel), [entries, rootLabel]);
  const allFolderOptions = useMemo(
    () =>
      Array.from(new Set([...folderOptions, ...files.folders, ...entryOptions.folders])).sort((a, b) =>
        a.localeCompare(b),
      ),
    [folderOptions, files.folders, entryOptions.folders],
  );
  const allTargetOptions = useMemo(
    () =>
      Array.from(new Set([...targetOptions, ...files.targets, ...entryOptions.targets])).sort((a, b) =>
        a.localeCompare(b),
      ),
    [targetOptions, files.targets, entryOptions.targets],
  );
  // The file statuses sit right after All: they are the work nobody has started.
  const fileSegmentCount = files.counts.untranscribed + files.counts.unqueued;
  const [allSegment, ...jobSegments] = statusSegments;
  const segments = [
    { ...allSegment, count: allSegment.count + fileSegmentCount },
    ...(files.counts.untranscribed > 0 || status === "needsTranscription"
      ? [
          {
            key: "needsTranscription" as const,
            label: t("library.filter.needsTranscription"),
            count: files.counts.untranscribed,
            color: "text-warning",
          },
        ]
      : []),
    ...(files.counts.unqueued > 0 || status === "notQueued"
      ? [
          {
            key: "notQueued" as const,
            label: t("library.row.notQueued"),
            count: files.counts.unqueued,
            color: "text-muted",
          },
        ]
      : []),
    ...jobSegments,
  ];
  const visibleEntries = useMemo(
    () =>
      entries
        .filter((entry) => fileMatchesStatus(entry, status))
        .filter((entry) => fileMatchesFilters(entry, query, folderFilter, targetFilter, rootLabel))
        .sort(
          (a, b) =>
            (a.item.folder || rootLabel).localeCompare(b.item.folder || rootLabel) ||
            a.item.name.localeCompare(b.item.name),
        ),
    [entries, status, query, folderFilter, targetFilter, rootLabel],
  );
  // In Files rows the filters count files, not jobs.
  const shownSegments =
    rows === "files"
      ? segments.map((segment) => ({
          ...segment,
          count: entries.filter((entry) => fileMatchesStatus(entry, segment.key)).length,
        }))
      : segments;

  // A job with no Library file (a Convert upload) has no file panel; its details stand in.
  const openFile = useCallback(
    (job: Job) => {
      if (!files.openJobFile(job)) onOpenDetails(job);
    },
    [files, onOpenDetails],
  );
  const translateFile = useCallback(
    (job: Job) => {
      if (!files.openJobFile(job, true)) onOpenDetails(job);
    },
    [files, onOpenDetails],
  );

  // "/" focuses the search box, as it did on the old Files view.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.closest("input, textarea, select, [contenteditable]") || document.querySelector('[aria-modal="true"]'))
        return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

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
      // With a folder chosen, the count above was that folder's: clear exactly those jobs.
      await clearJobsMutation.mutateAsync(
        folderFilter === "all"
          ? undefined
          : jobs.filter((j) => j.status === "done" || j.status === "error" || j.status === "skipped").map((j) => j.id),
      );
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
    if (rows === "files") {
      return <FileList entries={visibleEntries} rootLabel={rootLabel} onOpen={files.openFileKey} />;
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
          onOpenFile={openFile}
          onTranslateFile={translateFile}
          hasLeadingRows={files.visible.length > 0}
          leadingRows={files.visible.map((row) => <FileRowDesktop key={row.key} row={row} actions={files.actions} />)}
        />
      );
    }
    return (
      <div className="space-y-2 p-4">
        {filteredJobs.length === 0 && files.visible.length === 0 && (
          <EmptyHint text={t("dashboard.noJobsMatchFilter")} subtext={t("dashboard.emptyJobsHint")} />
        )}
        {files.visible.map((row) => (
          <FileCardMobile key={row.key} row={row} actions={files.actions} />
        ))}
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
            onOpenFile={openFile}
            onTranslateFile={translateFile}
          />
        ))}
      </div>
    );
  })();
  // A Library with nothing in it explains how to fill it instead of an empty table.
  const libraryEmpty = libraryQuery.data !== undefined && libraryQuery.data.files.length === 0 && allJobs.length === 0;

  return (
    <div className="flex min-h-[50dvh] flex-1">
      <section aria-label={t("library.view.jobs")} className="min-w-0 flex-1">
        {libraryEmpty ? (
          <LibraryEmpty />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-4 pt-3">
              <div
                role="group"
                aria-label={t("library.view.jobs")}
                className="flex shrink-0 rounded-sm border border-border p-1"
              >
                {(["jobs", "files"] as const).map((layout) => (
                  <button
                    key={layout}
                    type="button"
                    aria-pressed={rows === layout}
                    onClick={() => onRowsChange(layout)}
                    className={`min-h-[36px] rounded-sm px-3 text-sm transition-colors duration-fast ${rows === layout ? "bg-text font-medium text-surface" : "text-muted hover:text-text"}`}
                  >
                    {t(`library.view.${layout}`)}
                  </button>
                ))}
              </div>
              <label className="flex min-h-touch min-w-0 flex-1 items-center gap-2 rounded-sm border border-border bg-surface-raised px-3 focus-within:border-accent">
                <Icon name="search" className="text-muted" />
                <span className="sr-only">{t("library.searchLabel")}</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("library.search")}
                  className="min-w-0 flex-1 bg-transparent text-sm text-text outline-hidden placeholder:text-muted"
                />
                <kbd className="hidden rounded-sm border border-border px-1 font-mono text-xs text-muted sm:inline">
                  /
                </kbd>
              </label>
            </div>
            <div
              role="group"
              aria-label={t("dashboard.filtersLabel")}
              className="flex gap-2 overflow-x-auto border-b border-border px-4 py-3"
            >
              {shownSegments.map((segment) => {
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
              folderOptions={allFolderOptions}
              targetOptions={allTargetOptions}
              onFolderFilterChange={setFolderFilter}
              onTargetFilterChange={setTargetFilter}
              onClearFilters={() => {
                onStatusChange("all");
                setFolderFilter("all");
                setTargetFilter("all");
                setQuery("");
              }}
              // The bulk actions act on job rows; Files rows show none of them.
              visiblePendingIds={rows === "jobs" ? visiblePendingIds : []}
              visibleErrorIds={rows === "jobs" ? visibleErrorIds : []}
              visibleRetranslatableIds={rows === "jobs" ? visibleRetranslatableIds : []}
              finishedJobCount={rows === "jobs" ? finishedJobCount : 0}
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
                <ActionButton
                  size="sm"
                  variant="success"
                  onClick={handleRunSelected}
                  busy={startSelectedMutation.isPending}
                >
                  {t("dashboard.runSelected", { count: selectedPendingCount })}
                </ActionButton>
              )}
              <ActionButton
                size="sm"
                variant="danger"
                onClick={handleDeleteSelected}
                busy={deleteSelectedMutation.isPending}
              >
                {t("dashboard.deleteSelected")}
              </ActionButton>
            </SelectionBar>
            {libraryQuery.isError && (
              <div className="p-4 pb-0">
                <InlineError
                  message={t("library.loadFailed", { message: getErrorMessage(libraryQuery.error) })}
                  onRetry={() => void libraryQuery.refetch()}
                />
              </div>
            )}
            {list}
          </>
        )}
      </section>
      {files.openItem && (
        <LibraryPanel
          item={files.openItem}
          jobsById={jobsById}
          transcriptionEnabled={transcriptionEnabled}
          transcription={transcription}
          onClose={files.closePanel}
          onPreview={onPreview}
          onQueued={files.handleQueued}
          onOpenJob={onOpenJob}
          translateRequest={files.translateRequest}
        />
      )}
    </div>
  );
}
