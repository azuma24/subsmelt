import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useJobsQuery, useMutationWithInvalidation, useQueueStatusQuery, useSettingsQuery, useTasksQuery, useTranscriptionHistoryQuery } from "../../hooks";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import type { JobRow, ScannedFile } from "../../types";
import { ActionButton, EmptyHint, RowActionsMenu, SelectionBar } from "../../ui/primitives";
import { JobsTableDesktop } from "./JobsTableDesktop";
import { JobCardMobile } from "./JobCardMobile";
import { JobDetailsDrawer } from "./JobDetailsDrawer";
import { PreviewOverlay } from "./PreviewOverlay";
import { ScanResultsPanel, type ScanFilter } from "./ScanResultsPanel";
import { validDashboardSortBy, validDashboardSortDir, type DashboardSortBy, type DashboardSortDir } from "./scanSort";
import { useDashboardDerivedState } from "./useDashboardDerivedState";
import { DashboardHero } from "./DashboardHero";
import { QueueToolbar } from "./QueueToolbar";
import { TranscriptionHistoryPanel } from "./TranscriptionHistoryPanel";
import { ScanConfirmModal, type ScanPlan } from "./ScanConfirmModal";
import { useManualTranscription, type ScanResultMode } from "./useManualTranscription";
import { str } from "../../lib/settings-value";
import type { DashboardTab } from "./tabs";

const SETUP_DISMISSED_KEY = "subsmelt_setup_dismissed";


export function DashboardPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const navigate = useNavigate();
  const jobsQuery = useJobsQuery();
  const tasksQuery = useTasksQuery();
  const settingsQuery = useSettingsQuery();
  const queueStatusQuery = useQueueStatusQuery();
  const transcriptionHistoryQuery = useTranscriptionHistoryQuery(true, 8);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scanResult, setScanResult] = useState<ScannedFile[] | null>(null);
  const [scanListFilter, setScanListFilter] = useState<ScanFilter>("all");
  const [scanSearch, setScanSearch] = useState("");
  const [dashboardSortBy, setDashboardSortBy] = useState<DashboardSortBy>("date");
  const [dashboardSortDir, setDashboardSortDir] = useState<DashboardSortDir>("desc");
  const [previewJobId, setPreviewJobId] = useState<number | null>(null);
  const [previewSearch, setPreviewSearch] = useState("");
  const [detailsJob, setDetailsJob] = useState<JobRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // File-level selection for batch transcription (by videoPath), independent of
  // the job-id selection used for bulk translation.
  const [selectedVideoPaths, setSelectedVideoPaths] = useState<Set<string>>(new Set());
  const [scanResultMode, setScanResultMode] = useState<ScanResultMode>("queued");
  const [folderFilter, setFolderFilter] = useState("all");
  const [targetFilter, setTargetFilter] = useState("all");
  const [scanPlan, setScanPlan] = useState<ScanPlan | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>("queue");
  // Auto-hide onboarding: read from localStorage
  const [setupDismissed, setSetupDismissed] = useState(() => {
    try { return localStorage.getItem(SETUP_DISMISSED_KEY) === "1"; } catch { return false; }
  });

  const scanPreviewMutation = useMutationWithInvalidation(() => api.previewScan());
  const scanMutation = useMutationWithInvalidation(() => api.scanFolder());
  const startQueueMutation = useMutationWithInvalidation(() => api.startQueue());
  const startSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.startQueue(ids));
  const stopQueueMutation = useMutationWithInvalidation(() => api.stopQueue());
  const clearJobsMutation = useMutationWithInvalidation(() => api.clearJobs());
  const deleteSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.deleteJobsApi(ids));
  const retrySelectedMutation = useMutationWithInvalidation((ids: number[]) => api.retryJobsApi(ids));
  const forceSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.forceJobsApi(ids));
  const saveDashboardSortMutation = useMutationWithInvalidation((patch: Record<string, string>) => api.saveSettings(patch));

  const {
    transcriptionProgressByPath,
    transcribingPath,
    isTranscribePending,
    isRetryPending,
    handleTranscribe,
    handleCancelTranscription,
    handleBatchTranscribe,
    handleRetryTranscription,
  } = useManualTranscription({
    setScanResult,
    setScanResultMode,
    setSelectedVideoPaths,
    refreshScanPreview: () => scanPreviewMutation.mutateAsync(),
  });

  const jobs: JobRow[] = jobsQuery.data?.jobs || [];
  const queueRunning = Boolean(queueStatusQuery.data?.running ?? jobsQuery.data?.queueRunning ?? false);
  const currentJobId = queueStatusQuery.data?.currentJobId ?? jobsQuery.data?.currentJobId ?? null;
  const settings = settingsQuery.data || {};
  const mediaDir = str(settings._media_dir, "/media");
  const autoTranslate = str(settings.auto_translate, "1") === "1";
  const tasks = tasksQuery.data || [];
  const enabledTaskCount = tasks.filter((x) => x.enabled === 1).length;
  // Server-computed: the legacy llm_endpoint/model keys carry non-empty defaults,
  // so checking them client-side reported "configured" on a brand-new install and
  // ticked the quick-start step before the user had set anything up. Only the
  // server can compare against the shipped seed.
  const hasLlmConfig = settings._llm_configured === true;
  const transcriptionEnabled = str(settings.transcription_enabled, "0") === "1";
  const transcriptionAttempts = transcriptionHistoryQuery.data?.attempts || [];
  const tokenBudget = Math.max(0, parseInt(str(settings.monthly_token_budget, "0"), 10) || 0);

  useEffect(() => {
    if (!settingsQuery.isSuccess) return;
    setDashboardSortBy(validDashboardSortBy(settings.dashboard_sort_by));
    setDashboardSortDir(validDashboardSortDir(settings.dashboard_sort_dir));
  }, [settings.dashboard_sort_by, settings.dashboard_sort_dir, settingsQuery.isSuccess]);

  const handleDashboardSortByChange = (value: DashboardSortBy) => {
    setDashboardSortBy(value);
    saveDashboardSortMutation.mutate({ dashboard_sort_by: value });
  };

  const handleDashboardSortDirToggle = () => {
    setDashboardSortDir((current) => {
      const next: DashboardSortDir = current === "asc" ? "desc" : "asc";
      saveDashboardSortMutation.mutate({ dashboard_sort_dir: next });
      return next;
    });
  };

  // Summed token usage + approximate cost across all jobs (display-only).
  const usageTotals = jobs.reduce(
    (acc, job) => {
      acc.inputTokens += job.input_tokens || 0;
      acc.outputTokens += job.output_tokens || 0;
      if (typeof job.est_cost === "number") {
        acc.cost += job.est_cost;
        acc.hasCost = true;
      }
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, cost: 0, hasCost: false },
  );

  const {
    pendingJobs,
    activeJobs,
    doneJobs,
    errorJobs,
    jobsById,
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
    statusFilter,
    folderFilter,
    targetFilter,
    selectedIds,
    t,
  });

  // Auto-dismiss onboarding after first successful job
  useEffect(() => {
    if (!setupDismissed && doneJobs.length > 0) {
      try { localStorage.setItem(SETUP_DISMISSED_KEY, "1"); } catch { /* ignore */ }
      setSetupDismissed(true);
    }
  }, [doneJobs.length, setupDismissed]);

  useEffect(() => {
    const pendingIdSet = new Set(jobs.filter((j) => j.status === "pending").map((j) => j.id));
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => pendingIdSet.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [jobs]);

  const handlePreviewScan = async () => {
    try {
      const result = await scanPreviewMutation.mutateAsync();
      setScanResult(result.files);
      setSelectedVideoPaths(new Set());
      setScanResultMode("preview");
      setActiveTab("scan");
      addToast(t("dashboard.toast.scanPreviewComplete", { total: result.totalSubtitles, newJobs: result.newJobs }), "info");
    } catch (e: unknown) {
      addToast(t("dashboard.toast.scanFailed", { message: getErrorMessage(e) }), "error");
    }
  };

  const handleScan = async () => {
    try {
      const preview = await scanPreviewMutation.mutateAsync();
      const folderCounter = new Map<string, number>();
      for (const file of preview.files) {
        const p = file.videoPath || file.subtitles[0]?.srtPath || "";
        const chunks = p.replace(/\\/g, "/").split("/").filter(Boolean);
        const folder = chunks.length > 1 ? chunks[chunks.length - 2] : "root";
        folderCounter.set(folder, (folderCounter.get(folder) || 0) + 1);
      }
      const topFolders = [...folderCounter.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name} (${count})`);
      setScanPlan({
        files: preview.files,
        totalSubtitles: preview.totalSubtitles,
        newJobs: preview.newJobs,
        topFolders,
      });
    } catch (e: unknown) {
      addToast(t("dashboard.toast.scanFailed", { message: getErrorMessage(e) }), "error");
    }
  };

  const confirmQueueScan = async () => {
    if (!scanPlan) return;
    try {
      const result = await scanMutation.mutateAsync();
      setScanResult(result.files);
      setSelectedVideoPaths(new Set());
      setScanResultMode("queued");
      setScanPlan(null);
      setActiveTab("scan");
      addToast(t("dashboard.toast.scanComplete", { total: result.totalSubtitles, newJobs: result.newJobs }), "info");
    } catch (e: unknown) {
      addToast(t("dashboard.toast.scanFailed", { message: getErrorMessage(e) }), "error");
    }
  };

  const handleRunAll = async () => {
    try {
      await startQueueMutation.mutateAsync();
      addToast(t("dashboard.toast.queueStarted"), "info");
    } catch (e) {
      addToast(e instanceof Error ? e.message : t("dashboard.toast.actionFailed"), "error");
    }
  };

  const handleRunSelected = async () => {
    if (selectedPendingIds.length === 0) return;
    await startSelectedMutation.mutateAsync(selectedPendingIds);
    addToast(t("dashboard.toast.runSelectedStarted", { count: selectedPendingIds.length }), "info");
    setSelectedIds(new Set());
  };

  const handleStop = async () => {
    try {
      await stopQueueMutation.mutateAsync();
    } catch (e) {
      addToast(e instanceof Error ? e.message : t("dashboard.toast.actionFailed"), "error");
    }
  };

  const handleClearAll = async () => {
    const ok = await confirm({
      title: t("dashboard.confirm.clearTitle"),
      message: t("dashboard.confirm.clearMessage", { count: jobs.length }),
      confirmLabel: t("dashboard.confirm.clearConfirm"),
      danger: true,
    });
    if (ok) {
      await clearJobsMutation.mutateAsync();
      setScanResult(null);
      setSelectedIds(new Set());
      addToast(t("dashboard.toast.jobsCleared"), "info");
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

    const result = await deleteSelectedMutation.mutateAsync(selectedPendingIds);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      selectedPendingIds.forEach((id) => next.delete(id));
      return next;
    });
    addToast(t("dashboard.toast.selectedDeleted", { count: result.deleted }), "info");
  };

  const handleSelectVisiblePending = () => {
    setSelectedIds((prev) => new Set([...prev, ...visiblePendingIds]));
  };

  const handleRetryVisibleErrors = async () => {
    if (visibleErrorIds.length === 0) return;
    const result = await retrySelectedMutation.mutateAsync(visibleErrorIds);
    addToast(t("dashboard.toast.retrySelectedStarted", { count: result.updated }), "info");
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

    const result = await forceSelectedMutation.mutateAsync(visibleRetranslatableIds);
    addToast(t("dashboard.toast.forceSelectedStarted", { count: result.updated }), "info");
  };

  const toggleSelectedJob = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const quickChecks = [
    {
      done: hasLlmConfig,
      title: t("dashboard.quickStart.llmTitle"),
      hint: hasLlmConfig ? t("dashboard.quickStart.done") : t("dashboard.quickStart.llmHint"),
      action: t("dashboard.quickStart.openSettings"),
      onClick: () => navigate("/settings"),
    },
    {
      done: enabledTaskCount > 0,
      title: t("dashboard.quickStart.tasksTitle"),
      hint: enabledTaskCount > 0 ? t("dashboard.quickStart.done") : t("dashboard.quickStart.tasksHint"),
      action: t("dashboard.quickStart.openTranslations"),
      onClick: () => navigate("/translations"),
    },
    {
      done: pendingJobs.length > 0 || doneJobs.length > 0 || activeJobs.length > 0,
      title: t("dashboard.quickStart.mediaTitle"),
      hint: pendingJobs.length > 0 || doneJobs.length > 0 || activeJobs.length > 0 ? t("dashboard.quickStart.done") : t("dashboard.quickStart.mediaHint"),
      action: t("dashboard.quickStart.scanNow"),
      onClick: handleScan,
    },
    {
      done: queueRunning,
      title: t("dashboard.quickStart.queueTitle"),
      hint: queueRunning ? t("dashboard.quickStart.queueRunning") : t("dashboard.quickStart.queueIdle"),
      action: queueRunning ? t("dashboard.quickStart.stopQueue") : t("dashboard.quickStart.runQueue"),
      onClick: queueRunning ? handleStop : handleRunAll,
    },
  ];
  const showQuickStart = !setupDismissed && quickChecks.some((step) => !step.done);

  // Dashboard tabs: Queue / Transcription / Scan results
  const dashboardTabs = [
    { key: "queue" as DashboardTab, label: t("dashboard.tab.queue"), count: jobs.length },
    ...(transcriptionEnabled ? [{ key: "transcription" as DashboardTab, label: t("dashboard.tab.transcription"), count: transcriptionAttempts.length }] : []),
    ...(scanResult ? [{ key: "scan" as DashboardTab, label: t("dashboard.tab.scan"), count: scanResult.length }] : []),
  ];

  const selectStatus = (key: string) => { setStatusFilter(key); setActiveTab("queue"); };

  return (
    <div className="flex min-h-full flex-col">
      {/* ── Topbar (L1 — Executive Summary) ── */}
      <div className="sticky top-0 z-30 flex h-[50px] shrink-0 items-center gap-2.5 border-b border-[var(--border)] bg-[var(--surface)] px-3.5 md:px-[18px]">
        {/* Title with readable typography */}
        <span className="flex-1 text-balance text-2xl sr-only md:not-sr-only md:text-sm font-semibold text-[var(--text)]">{t("nav.dashboard")}</span>
        <span className="flex-1 text-pretty text-sm font-semibold text-[var(--text)] md:hidden">{t("nav.dashboard")}</span>
        {/* Scan + Run actions */}
        <div
          className="flex items-center gap-1.5"
          aria-label={t("dashboard.hero.scanActions")}
        >
          {/* At phone widths three buttons wrap the 50px topbar onto two cramped
              lines — the scan actions collapse into a menu and only the primary
              Run/Stop control stays out. */}
          {isMobile ? (
            <RowActionsMenu
              items={[
                { label: scanPreviewMutation.isPending ? t("dashboard.previewing") : t("dashboard.previewScan"), onClick: handlePreviewScan, disabled: scanPreviewMutation.isPending || scanMutation.isPending },
                { label: scanMutation.isPending ? t("dashboard.scanning") : t("dashboard.scanFolders"), onClick: handleScan, disabled: scanMutation.isPending || scanPreviewMutation.isPending },
              ]}
            />
          ) : (
            <>
              <ActionButton variant="ghost" size="sm" onClick={handlePreviewScan} busy={scanPreviewMutation.isPending} disabled={scanMutation.isPending}>
                {scanPreviewMutation.isPending ? t("dashboard.previewing") : t("dashboard.previewScan")}
              </ActionButton>
              <ActionButton variant="ghost" size="sm" onClick={handleScan} busy={scanMutation.isPending} disabled={scanPreviewMutation.isPending}>
                {scanMutation.isPending ? t("dashboard.scanning") : t("dashboard.scanFolders")}
              </ActionButton>
              <span className="mx-0.5 hidden h-[18px] w-px bg-[var(--border)] sm:block" />
            </>
          )}
          {queueRunning ? (
            <ActionButton variant="danger" size="sm" onClick={handleStop}>{t("dashboard.stop")}</ActionButton>
          ) : (
            <ActionButton variant="success" size="sm" onClick={handleRunAll} disabled={pendingJobs.length === 0}>{t("dashboard.runAll")}</ActionButton>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 space-y-4 p-3.5 md:p-[18px]">

        {/* L1: Cockpit metric band — status filters + token usage in one row */}
        <DashboardHero
          statusSegments={statusSegments}
          statusFilter={statusFilter}
          activeJobs={activeJobs}
          pendingJobs={pendingJobs}
          completedJobs={doneJobs}
          usageTotals={usageTotals}
          tokenBudget={tokenBudget}
          onSelectStatus={selectStatus}
          t={t}
        />

        {/* Onboarding quick-start cards — auto-hidden after first successful job */}
        {showQuickStart && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11.5px] text-[var(--text-3)]">{t("dashboard.quickStart.title")}</span>
              <button
                type="button"
                onClick={() => {
                  try { localStorage.setItem(SETUP_DISMISSED_KEY, "1"); } catch { /* ignore */ }
                  setSetupDismissed(true);
                }}
                className="text-[11px] text-[var(--text-3)] hover:text-[var(--text)]"
              >
                {t("dashboard.quickStart.dismiss")}
              </button>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
              {quickChecks.map((step) => (
                <div key={step.title} className={`rounded-xl border p-3 ${step.done ? "border-[var(--green-border)] bg-[var(--green-dim)]" : "border-[var(--border)] bg-[var(--surface)]"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-[var(--text)]">{step.title}</div>
                    <span className={`text-[11px] ${step.done ? "text-[var(--green)]" : "text-[var(--yellow)]"}`}>{step.done ? "✓" : "○"}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--text-2)]">{step.hint}</div>
                  {!step.done && (
                    <button onClick={step.onClick} className="mt-2 text-xs text-[var(--accent)]">{step.action}</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Auto-translate notice (L2) — shown only when off */}
        {!autoTranslate && (
          <p className="text-[12px] text-[var(--text-2)]">
            {t("dashboard.scanAutoTranslateOff")}
          </p>
        )}

        {/* ── Main content area with Tabs: Queue / Transcription / Scan results ── */}
        <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {/* Tab header + bulk actions + filters. Status filtering is not here —
              it lives in the hero band above, which is the single source. */}
          <QueueToolbar
            dashboardTabs={dashboardTabs}
            activeTab={activeTab}
            onSelectTab={setActiveTab}
            hasQueueFilters={hasQueueFilters}
            folderFilter={folderFilter}
            targetFilter={targetFilter}
            folderOptions={folderOptions}
            targetOptions={targetOptions}
            onFolderFilterChange={setFolderFilter}
            onTargetFilterChange={setTargetFilter}
            onClearFilters={() => { setStatusFilter("all"); setFolderFilter("all"); setTargetFilter("all"); }}
            visiblePendingIds={visiblePendingIds}
            visibleErrorIds={visibleErrorIds}
            visibleRetranslatableIds={visibleRetranslatableIds}
            jobsCount={jobs.length}
            isRetryPending={retrySelectedMutation.isPending}
            isForcePending={forceSelectedMutation.isPending}
            onSelectVisiblePending={handleSelectVisiblePending}
            onRetryVisibleErrors={handleRetryVisibleErrors}
            onRetranslateVisible={handleRetranslateVisible}
            onClearAll={handleClearAll}
            t={t}
          />

          {/* L3: SelectionBar — appears only when items selected */}
          <SelectionBar
            count={selectedPendingCount}
            summaryLabel={t("dashboard.selectionSummary", { count: selectedPendingCount })}
            hintLabel={t("dashboard.selectionHint")}
            onClear={() => setSelectedIds(new Set())}
            clearLabel={t("dashboard.clearSelection")}
            isMobile={isMobile}
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

          {/* Tab content */}
          {activeTab === "queue" && (
            isMobile ? (
              <div className="space-y-2 p-3.5">
                {filteredJobs.length === 0 && <EmptyHint text={t("dashboard.noJobsMatchFilter")} subtext={t("dashboard.emptyJobsHint")} />}
                {filteredJobs.map((job) => (
                  <JobCardMobile
                    key={job.id}
                    job={job}
                    currentJobId={currentJobId}
                    selected={selectedIds.has(job.id)}
                    onToggleSelected={toggleSelectedJob}
                    onPreview={setPreviewJobId}
                    onOpenLogs={(jobId) => navigate(`/logs?job=${jobId}`)}
                    onOpenDetails={setDetailsJob}
                  />
                ))}
              </div>
            ) : (
              <JobsTableDesktop jobs={filteredJobs} currentJobId={currentJobId} selectedIds={selectedIds} setSelectedIds={setSelectedIds} onPreview={setPreviewJobId} onOpenLogs={(jobId) => navigate(`/logs?job=${jobId}`)} onOpenDetails={setDetailsJob} />
            )
          )}

          {activeTab === "transcription" && transcriptionEnabled && (
            <TranscriptionHistoryPanel
              attempts={transcriptionAttempts}
              transcribingPath={transcribingPath}
              isRetryPending={isRetryPending}
              isTranscribePending={isTranscribePending}
              onRetry={handleRetryTranscription}
            />
          )}

          {activeTab === "scan" && scanResult && (
            <div className="p-3.5">
              <ScanResultsPanel
                files={scanResult}
                filter={scanListFilter}
                setFilter={setScanListFilter}
                search={scanSearch}
                setSearch={setScanSearch}
                jobsById={jobsById}
                selectedIds={selectedIds}
                setSelectedIds={setSelectedIds}
                mode={scanResultMode}
                onQueueAll={handleScan}
                onTranscribe={handleTranscribe}
                onCancelTranscribe={handleCancelTranscription}
                selectedVideoPaths={selectedVideoPaths}
                setSelectedVideoPaths={setSelectedVideoPaths}
                onBatchTranscribe={handleBatchTranscribe}
                transcriptionEnabled={transcriptionEnabled}
                transcriptionProgressByPath={transcriptionProgressByPath}
                isQueueing={scanMutation.isPending}
                newJobsCount={scanResult.flatMap((file) => file.subtitles.flatMap((sub) => sub.tasks)).filter((task) => task.status === "new").length}
                mediaDir={mediaDir}
                sortBy={dashboardSortBy}
                sortDir={dashboardSortDir}
                onSortByChange={handleDashboardSortByChange}
                onToggleSortDir={handleDashboardSortDirToggle}
              />
            </div>
          )}
        </section>
      </div>

      <JobDetailsDrawer
        job={detailsJob}
        open={!!detailsJob}
        onClose={() => setDetailsJob(null)}
        onOpenLogs={(jobId) => navigate(`/logs?job=${jobId}`)}
      />

      {previewJobId !== null && (
        <PreviewOverlay
          isMobile={isMobile}
          jobId={previewJobId}
          previewSearch={previewSearch}
          setPreviewSearch={setPreviewSearch}
          onClose={() => { setPreviewJobId(null); setPreviewSearch(""); }}
        />
      )}

      {scanPlan && (
        <ScanConfirmModal
          scanPlan={scanPlan}
          onClose={() => setScanPlan(null)}
          onConfirm={confirmQueueScan}
          t={t}
        />
      )}
    </div>
  );
}
