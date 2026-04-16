import { NavLink, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useJobsQuery, useMutationWithInvalidation, useQueueStatusQuery, useSettingsQuery, useTasksQuery } from "../../hooks";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import type { JobRow, ScannedFile } from "../../types";
import { ActionButton, EmptyHint, StatCard } from "../../ui/primitives";
import { ActiveJobCard } from "./ActiveJobCard";
import { JobsTableDesktop } from "./JobsTableDesktop";
import { JobCardMobile } from "./JobCardMobile";
import { PreviewOverlay } from "./PreviewOverlay";
import { ScanResultsPanel, getScanGroupName, type ScanFilter } from "./ScanResultsPanel";

type ScanResultMode = "preview" | "queued";

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function parentFolderLabel(filePath: string, mediaDir: string, rootLabel: string, externalLabel: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedMedia = mediaDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = normalizedPath.startsWith(`${normalizedMedia}/`)
    ? normalizedPath.slice(normalizedMedia.length + 1)
    : "";

  if (!relative) return externalLabel;
  const parts = relative.split("/");
  parts.pop();
  const folder = parts.join("/");
  return folder || rootLabel;
}

interface ScanPlan {
  files: ScannedFile[];
  totalSubtitles: number;
  newJobs: number;
  topFolders: string[];
}

export function DashboardPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const navigate = useNavigate();
  const jobsQuery = useJobsQuery();
  const tasksQuery = useTasksQuery();
  const settingsQuery = useSettingsQuery();
  const queueStatusQuery = useQueueStatusQuery();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scanResult, setScanResult] = useState<ScannedFile[] | null>(null);
  const [scanListFilter, setScanListFilter] = useState<ScanFilter>("all");
  const [scanSearch, setScanSearch] = useState("");
  const [expandedScanGroups, setExpandedScanGroups] = useState<Set<string>>(new Set());
  const [previewJobId, setPreviewJobId] = useState<number | null>(null);
  const [previewSearch, setPreviewSearch] = useState("");
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [scanResultMode, setScanResultMode] = useState<ScanResultMode>("queued");
  const [folderFilter, setFolderFilter] = useState("all");
  const [targetFilter, setTargetFilter] = useState("all");
  const [scanPlan, setScanPlan] = useState<ScanPlan | null>(null);

  const scanPreviewMutation = useMutationWithInvalidation(() => api.previewScan());
  const scanMutation = useMutationWithInvalidation(() => api.scanFolder());
  const startQueueMutation = useMutationWithInvalidation(() => api.startQueue());
  const startSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.startQueue(ids));
  const stopQueueMutation = useMutationWithInvalidation(() => api.stopQueue());
  const clearJobsMutation = useMutationWithInvalidation(() => api.clearJobs());
  const deleteSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.deleteJobsApi(ids));
  const retrySelectedMutation = useMutationWithInvalidation((ids: number[]) => api.retryJobsApi(ids));
  const forceSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.forceJobsApi(ids));

  const jobs: JobRow[] = jobsQuery.data?.jobs || [];
  const queueRunning = Boolean(queueStatusQuery.data?.running ?? jobsQuery.data?.queueRunning ?? false);
  const currentJobId = queueStatusQuery.data?.currentJobId ?? jobsQuery.data?.currentJobId ?? null;
  const settings = settingsQuery.data || {};
  const mediaDir = str(settings._media_dir, "/media");
  const autoTranslate = str(settings.auto_translate, "1") === "1";
  const tasks = tasksQuery.data || [];
  const taskCount = tasks.length;
  const enabledTaskCount = tasks.filter((x) => x.enabled === 1).length;
  const hasLlmConfig = Boolean(str(settings.llm_endpoint)) && Boolean(str(settings.model));

  const pendingJobs = jobs.filter((j) => j.status === "pending");
  const selectedPendingCount = pendingJobs.filter((j) => selectedIds.has(j.id)).length;
  const activeJobs = jobs.filter((j) => j.status === "translating");
  const doneJobs = jobs.filter((j) => j.status === "done");
  const errorJobs = jobs.filter((j) => j.status === "error");
  const activeJob = activeJobs[0];
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const selectedPendingIds = pendingJobs.filter((j) => selectedIds.has(j.id)).map((j) => j.id);
  const folderOptions = useMemo(() => Array.from(new Set(
    jobs.map((job) => parentFolderLabel(job.srt_path, mediaDir, t("dashboard.folderRoot"), t("dashboard.folderExternal")))
  )).sort((a, b) => a.localeCompare(b)), [jobs, mediaDir, t]);
  const targetOptions = useMemo(() => Array.from(new Set(
    jobs.map((job) => `${job.target_lang || job.lang_code} (${job.lang_code})`)
  )).sort((a, b) => a.localeCompare(b)), [jobs]);
  const filteredJobs = jobs.filter((j) => {
    const statusMatches = statusFilter === "all" || j.status === statusFilter;
    const folderMatches = folderFilter === "all" || parentFolderLabel(j.srt_path, mediaDir, t("dashboard.folderRoot"), t("dashboard.folderExternal")) === folderFilter;
    const targetMatches = targetFilter === "all" || `${j.target_lang || j.lang_code} (${j.lang_code})` === targetFilter;
    return statusMatches && folderMatches && targetMatches;
  });
  const visiblePendingIds = filteredJobs.filter((j) => j.status === "pending").map((j) => j.id);
  const visibleErrorIds = filteredJobs.filter((j) => j.status === "error").map((j) => j.id);
  const visibleDoneIds = filteredJobs.filter((j) => j.status === "done").map((j) => j.id);
  const visibleRetranslatableIds = filteredJobs.filter((j) => j.status === "done" || j.status === "skipped").map((j) => j.id);
  const hasQueueFilters = statusFilter !== "all" || folderFilter !== "all" || targetFilter !== "all";

  const filterTabs = [
    { key: "all", label: t("dashboard.filter.all"), count: jobs.length },
    { key: "pending", label: t("dashboard.filter.pending"), count: pendingJobs.length },
    { key: "translating", label: t("dashboard.filter.translating"), count: activeJobs.length },
    { key: "done", label: t("dashboard.filter.done"), count: doneJobs.length },
    { key: "error", label: t("dashboard.filter.error"), count: errorJobs.length },
  ];

  useEffect(() => {
    const pendingIdSet = new Set(jobs.filter((j) => j.status === "pending").map((j) => j.id));
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => pendingIdSet.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [jobs]);

  const expandInterestingScanGroups = (files: ScannedFile[]) => {
    const initialGroups = new Set<string>();
    files.forEach((file: ScannedFile) => {
      const group = getScanGroupName(file);
      const hasNew = file.subtitles.some((sub) => sub.tasks.some((task) => task.status === "new" || task.status === "pending"));
      const missing = file.videoName && file.subtitles.length === 0;
      const orphan = !file.videoName;
      if (hasNew || missing || orphan) initialGroups.add(group);
    });
    setExpandedScanGroups(initialGroups);
  };

  const handlePreviewScan = async () => {
    try {
      const result = await scanPreviewMutation.mutateAsync();
      setScanResult(result.files);
      setScanResultMode("preview");
      expandInterestingScanGroups(result.files);
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
      setScanResultMode("queued");
      expandInterestingScanGroups(result.files);
      setScanPlan(null);
      addToast(t("dashboard.toast.scanComplete", { total: result.totalSubtitles, newJobs: result.newJobs }), "info");
    } catch (e: unknown) {
      addToast(t("dashboard.toast.scanFailed", { message: getErrorMessage(e) }), "error");
    }
  };

  const handleRunAll = async () => {
    await startQueueMutation.mutateAsync();
    addToast(t("dashboard.toast.queueStarted"), "info");
  };

  const handleRunSelected = async () => {
    if (selectedPendingIds.length === 0) return;
    await startSelectedMutation.mutateAsync(selectedPendingIds);
    addToast(t("dashboard.toast.runSelectedStarted", { count: selectedPendingIds.length }), "info");
    setSelectedIds(new Set());
  };

  const handleStop = async () => {
    await stopQueueMutation.mutateAsync();
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
      onClick: () => navigate("/tasks"),
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

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-6">
      <div className="space-y-6">
        <section className="rounded-3xl border border-gray-800 bg-gradient-to-br from-gray-900 to-gray-950 p-5 md:p-6">
          <div className={`flex ${isMobile ? "flex-col gap-4" : "items-start justify-between gap-4"}`}>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">SubSmelt</h1>
              <p className="mt-2 max-w-2xl text-sm text-gray-400">
                {autoTranslate ? t("dashboard.scanAutoTranslateOn") : t("dashboard.scanAutoTranslateOff")}
              </p>
            </div>
            <div className={`flex ${isMobile ? "grid grid-cols-2 gap-2" : "flex-wrap gap-2"}`}>
              <ActionButton variant="ghost" onClick={handlePreviewScan} busy={scanPreviewMutation.isPending} disabled={scanMutation.isPending}>
                {scanPreviewMutation.isPending ? t("dashboard.previewing") : t("dashboard.previewScan")}
              </ActionButton>
              <ActionButton onClick={handleScan} busy={scanMutation.isPending} disabled={scanPreviewMutation.isPending}>
                {scanMutation.isPending ? t("dashboard.scanning") : t("dashboard.scanFolders")}
              </ActionButton>
              {!queueRunning ? (
                <>
                  <ActionButton variant="success" onClick={handleRunAll} disabled={pendingJobs.length === 0}>{t("dashboard.runAll")}</ActionButton>
                  <ActionButton
                    variant="success"
                    onClick={handleRunSelected}
                    disabled={selectedPendingCount === 0 || startSelectedMutation.isPending}
                  >
                    {t("dashboard.runSelected", { count: selectedPendingCount })}
                  </ActionButton>
                </>
              ) : (
                <ActionButton variant="danger" onClick={handleStop}>{t("dashboard.stop")}</ActionButton>
              )}
              {jobs.length > 0 && <ActionButton variant="ghost" onClick={handleClearAll}>{t("dashboard.clearAll")}</ActionButton>}
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {quickChecks.map((step, idx) => (
              <div key={idx} className={`rounded-2xl border p-3 ${step.done ? "border-green-900/40 bg-green-900/10" : "border-gray-800 bg-gray-900/40"}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-gray-200">{step.title}</div>
                  <span className={`text-[10px] ${step.done ? "text-green-300" : "text-yellow-300"}`}>{step.done ? "✓" : "○"}</span>
                </div>
                <div className="mt-1 text-[11px] text-gray-500">{step.hint}</div>
                {!step.done && (
                  <button onClick={step.onClick} className="mt-2 text-xs text-blue-400">{step.action}</button>
                )}
              </div>
            ))}
          </div>
        </section>

        {activeJob && <ActiveJobCard job={activeJob} pendingCount={pendingJobs.length} />}

        <section className={`grid gap-3 ${isMobile ? "grid-cols-2" : "grid-cols-4"}`}>
          <StatCard label={t("dashboard.stat.pending")} value={pendingJobs.length} color="text-yellow-400" />
          <StatCard label={t("dashboard.stat.translating")} value={activeJobs.length} color="text-blue-400" />
          <StatCard label={t("dashboard.stat.done")} value={doneJobs.length} color="text-green-400" />
          <StatCard label={t("dashboard.stat.errors")} value={errorJobs.length} color="text-red-400" />
        </section>

        <section className="overflow-hidden rounded-3xl border border-gray-800 bg-gray-900/80">
          <div className="space-y-3 border-b border-gray-800 px-4 py-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">{t("app.queueSectionTitle")}</h2>
                <p className="text-xs text-gray-500">{t("app.queueSectionSubtitle")}</p>
              </div>
              <div className="flex gap-2 overflow-x-auto">
                {filterTabs.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setStatusFilter(tab.key)}
                    className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${statusFilter === tab.key ? "border border-blue-500/30 bg-blue-600/15 text-white" : "bg-gray-800 text-gray-400"}`}
                  >
                    {tab.label} {tab.count > 0 && <span className="ml-1 opacity-70">{tab.count}</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <label className="min-w-0">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">{t("dashboard.queueFilterFolder")}</span>
                <select
                  value={folderFilter}
                  onChange={(e) => setFolderFilter(e.target.value)}
                  className="w-full md:max-w-[20rem] rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200"
                >
                  <option value="all">{t("dashboard.queueFilterAllFolders")}</option>
                  {folderOptions.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
                </select>
              </label>
              <label className="min-w-0">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">{t("dashboard.queueFilterTarget")}</span>
                <select
                  value={targetFilter}
                  onChange={(e) => setTargetFilter(e.target.value)}
                  className="w-full md:max-w-[20rem] rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200"
                >
                  <option value="all">{t("dashboard.queueFilterAllTargets")}</option>
                  {targetOptions.map((target) => <option key={target} value={target}>{target}</option>)}
                </select>
              </label>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => { setStatusFilter("all"); setFolderFilter("all"); setTargetFilter("all"); }}
                  disabled={!hasQueueFilters}
                  className="w-full rounded-lg bg-gray-800 px-3 py-2 text-xs font-medium text-gray-300 disabled:opacity-40"
                >
                  {t("dashboard.clearQueueFilters")}
                </button>
              </div>
            </div>

            <div className="sticky top-0 z-20 -mx-4 border-y border-gray-800 bg-gray-950/90 px-4 py-2 backdrop-blur">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleSelectVisiblePending}
                  disabled={visiblePendingIds.length === 0}
                  className="rounded-lg bg-gray-800 px-3 py-2 text-xs font-medium text-gray-300 disabled:opacity-40"
                >
                  {t("dashboard.selectVisiblePending", { count: visiblePendingIds.length })}
                </button>
                <button
                  type="button"
                  onClick={handleRetryVisibleErrors}
                  disabled={visibleErrorIds.length === 0 || retrySelectedMutation.isPending}
                  className="rounded-lg bg-yellow-900/50 px-3 py-2 text-xs font-medium text-yellow-100 disabled:opacity-40"
                >
                  {t("dashboard.retryVisibleErrors", { count: visibleErrorIds.length })}
                </button>
                <button
                  type="button"
                  onClick={handleRetranslateVisible}
                  disabled={visibleRetranslatableIds.length === 0 || forceSelectedMutation.isPending}
                  className="rounded-lg bg-gray-800 px-3 py-2 text-xs font-medium text-gray-300 disabled:opacity-40"
                >
                  {t("dashboard.retranslateVisible", { count: visibleRetranslatableIds.length })}
                </button>
                <button
                  type="button"
                  onClick={handleRunAll}
                  disabled={queueRunning || pendingJobs.length === 0}
                  className="rounded-lg bg-green-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                >
                  {t("dashboard.runAll")}
                </button>
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={!queueRunning}
                  className="rounded-lg bg-red-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                >
                  {t("dashboard.stop")}
                </button>
                <button
                  type="button"
                  onClick={handleClearAll}
                  disabled={jobs.length === 0}
                  className="rounded-lg bg-gray-800 px-3 py-2 text-xs font-medium text-gray-300 disabled:opacity-40"
                >
                  {t("dashboard.clearAll")}
                </button>
                <span className="ml-auto self-center text-[11px] text-gray-500">
                  {t("dashboard.quickCounts", { pending: pendingJobs.length, errors: visibleErrorIds.length, done: visibleDoneIds.length })}
                </span>
              </div>
            </div>
          </div>
          {selectedPendingCount > 0 && (
            <div className={`border-b border-blue-900/40 bg-blue-950/20 px-4 py-3 ${isMobile ? "space-y-3" : "flex items-center justify-between gap-3"}`}>
              <div>
                <div className="text-sm font-medium text-blue-100">{t("dashboard.selectionSummary", { count: selectedPendingCount })}</div>
                <div className="text-xs text-blue-200/60">{t("dashboard.selectionHint")}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {!queueRunning && (
                  <button
                    type="button"
                    onClick={handleRunSelected}
                    disabled={startSelectedMutation.isPending}
                    className="rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {t("dashboard.runSelected", { count: selectedPendingCount })}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  disabled={deleteSelectedMutation.isPending}
                  className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                >
                  {t("dashboard.deleteSelected")}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="rounded-lg bg-gray-800 px-3 py-2 text-xs font-medium text-gray-300"
                >
                  {t("dashboard.clearSelection")}
                </button>
              </div>
            </div>
          )}
          {isMobile ? (
            <div className="space-y-3 p-4">
              {filteredJobs.length === 0 && <EmptyHint text={t("dashboard.noJobsMatchFilter")} subtext={t("dashboard.emptyJobsHint")} />}
              {filteredJobs.map((job) => (
                <JobCardMobile
                  key={job.id}
                  job={job}
                  currentJobId={currentJobId}
                  expandedErrors={expandedErrors}
                  setExpandedErrors={setExpandedErrors}
                  selected={selectedIds.has(job.id)}
                  onToggleSelected={toggleSelectedJob}
                  onPreview={setPreviewJobId}
                  onOpenLogs={(jobId) => navigate(`/logs?job=${jobId}`)}
                />
              ))}
            </div>
          ) : (
            <JobsTableDesktop jobs={filteredJobs} currentJobId={currentJobId} expandedErrors={expandedErrors} setExpandedErrors={setExpandedErrors} selectedIds={selectedIds} setSelectedIds={setSelectedIds} onPreview={setPreviewJobId} onOpenLogs={(jobId) => navigate(`/logs?job=${jobId}`)} />
          )}
        </section>

        {scanResult && (
          <ScanResultsPanel
            files={scanResult}
            filter={scanListFilter}
            setFilter={setScanListFilter}
            search={scanSearch}
            setSearch={setScanSearch}
            expandedGroups={expandedScanGroups}
            setExpandedGroups={setExpandedScanGroups}
            jobsById={jobsById}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            mode={scanResultMode}
            onQueueAll={handleScan}
            isQueueing={scanMutation.isPending}
            newJobsCount={scanResult.flatMap((file) => file.subtitles.flatMap((sub) => sub.tasks)).filter((task) => task.status === "new").length}
          />
        )}
      </div>

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
        <div className="fixed inset-0 z-50 bg-black/70 p-4" onClick={() => setScanPlan(null)}>
          <div className="mx-auto mt-16 w-full max-w-xl rounded-3xl border border-gray-700 bg-gray-900 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => setScanPlan(null)}
                className="rounded-full border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-300 hover:text-white"
                aria-label={t("common.close")}
                title={t("common.close")}
              >
                ×
              </button>
            </div>
            <h3 className="text-lg font-semibold text-white">{t("dashboard.scanConfirm.title")}</h3>
            <p className="mt-2 text-sm text-gray-400">{t("dashboard.scanConfirm.summary", { subtitles: scanPlan.totalSubtitles, jobs: scanPlan.newJobs })}</p>
            <div className="mt-3 rounded-xl bg-gray-800/60 p-3">
              <div className="text-xs text-gray-500">{t("dashboard.scanConfirm.topFolders")}</div>
              <div className="mt-1 text-sm text-gray-200">{scanPlan.topFolders.length > 0 ? scanPlan.topFolders.join(", ") : t("dashboard.scanConfirm.none")}</div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setScanPlan(null)} className="rounded-xl bg-gray-800 px-3 py-2 text-sm text-gray-300">{t("common.cancel")}</button>
              <button onClick={confirmQueueScan} className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white">{t("dashboard.scanConfirm.proceed")}</button>
            </div>
          </div>
        </div>
      )}

      {isMobile && (
        <div className="fixed bottom-20 left-0 right-0 z-40 px-4">
          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-gray-700 bg-gray-900/95 p-2 backdrop-blur">
            <button onClick={handleScan} className="rounded-xl bg-blue-700 px-2 py-3 text-xs font-semibold text-white">{t("dashboard.scanFolders")}</button>
            {!queueRunning ? (
              <button onClick={handleRunAll} disabled={pendingJobs.length === 0} className="rounded-xl bg-green-700 px-2 py-3 text-xs font-semibold text-white disabled:opacity-40">{t("dashboard.runAll")}</button>
            ) : (
              <button onClick={handleStop} className="rounded-xl bg-red-700 px-2 py-3 text-xs font-semibold text-white">{t("dashboard.stop")}</button>
            )}
            <button onClick={() => navigate("/logs")} className="rounded-xl bg-gray-800 px-2 py-3 text-xs font-semibold text-gray-200">{t("nav.logs")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface StepRowProps {
  done: boolean;
  label: string;
  action: string;
  to?: string;
  onClick?: () => void;
}

function StepRow({ done, label, action, to, onClick }: StepRowProps) {
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] ${done ? "bg-green-900/50 text-green-400" : "bg-gray-800 text-gray-500"}`}>
        {done ? "✓" : "○"}
      </span>
      <span className={`flex-1 ${done ? "text-gray-500 line-through" : "text-gray-300"}`}>{label}</span>
      {!done && (to
        ? <NavLink to={to} className="text-xs text-blue-400">{action}</NavLink>
        : <button onClick={onClick} className="text-xs text-blue-400">{action}</button>)}
    </div>
  );
}
