import { useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useJobsQuery, useMutationWithInvalidation, useQueueStatusQuery, useSettingsQuery, useTasksQuery, useTranscriptionHistoryQuery } from "../../hooks";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import { ModalShell } from "../../components/ModalShell";
import type { JobRow, ScannedFile, TranscribePostAction, TranscriptionHistoryEntry } from "../../types";
import { ActionButton, Accordion, EmptyHint, SelectionBar, StatusStrip, StatCard, Tabs } from "../../ui/primitives";
import { ActiveJobCard } from "./ActiveJobCard";
import { JobsTableDesktop } from "./JobsTableDesktop";
import { JobCardMobile } from "./JobCardMobile";
import { PreviewOverlay } from "./PreviewOverlay";
import { ScanResultsPanel, getScanGroupName, type ScanFilter } from "./ScanResultsPanel";
import {
  createManualTranscriptionProgress,
  transitionManualTranscriptionProgress,
  type ManualTranscriptionProgress,
} from "./transcription-progress";

type ScanResultMode = "preview" | "queued";
type DashboardTab = "queue" | "transcription" | "scan";

const SETUP_DISMISSED_KEY = "subsmelt_setup_dismissed";

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
  const transcriptionHistoryQuery = useTranscriptionHistoryQuery(true, 8);
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
  const [transcriptionProgressByPath, setTranscriptionProgressByPath] = useState<Record<string, ManualTranscriptionProgress>>({});
  const [transcribingPath, setTranscribingPath] = useState<string | null>(null);
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
  const transcribeMutation = useMutationWithInvalidation((payload: { videoPath: string; postAction: TranscribePostAction }) => api.transcribeVideo(payload));
  const retryTranscriptionMutation = useMutationWithInvalidation((id: string) => api.retryTranscriptionAttempt(id));

  const jobs: JobRow[] = jobsQuery.data?.jobs || [];
  const queueRunning = Boolean(queueStatusQuery.data?.running ?? jobsQuery.data?.queueRunning ?? false);
  const currentJobId = queueStatusQuery.data?.currentJobId ?? jobsQuery.data?.currentJobId ?? null;
  const settings = settingsQuery.data || {};
  const mediaDir = str(settings._media_dir, "/media");
  const autoTranslate = str(settings.auto_translate, "1") === "1";
  const tasks = tasksQuery.data || [];
  const enabledTaskCount = tasks.filter((x) => x.enabled === 1).length;
  const hasLlmConfig = Boolean(str(settings.llm_endpoint)) && Boolean(str(settings.model));
  const transcriptionEnabled = str(settings.transcription_enabled, "0") === "1";
  const transcriptionAttempts = transcriptionHistoryQuery.data?.attempts || [];

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
      setScanResultMode("queued");
      expandInterestingScanGroups(result.files);
      setScanPlan(null);
      setActiveTab("scan");
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

  const updateTranscriptionProgress = (
    videoPath: string,
    updater: ManualTranscriptionProgress | ((current: ManualTranscriptionProgress) => ManualTranscriptionProgress),
  ) => {
    setTranscriptionProgressByPath((prev) => {
      const current = prev[videoPath];
      if (!current) return prev;
      const next = typeof updater === "function"
        ? (updater as (current: ManualTranscriptionProgress) => ManualTranscriptionProgress)(current)
        : updater;
      return { ...prev, [videoPath]: next };
    });
  };

  const handleTranscribe = async (videoPath: string, postAction: TranscribePostAction) => {
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

      if (result.scanResult?.files) {
        setScanResult(result.scanResult.files);
        setScanResultMode(postAction === "transcribe_and_translate" ? "queued" : "preview");
        expandInterestingScanGroups(result.scanResult.files);
      } else {
        const refreshed = await scanPreviewMutation.mutateAsync();
        setScanResult(refreshed.files);
        setScanResultMode("preview");
        expandInterestingScanGroups(refreshed.files);
      }
      updateTranscriptionProgress(videoPath, (current) =>
        transitionManualTranscriptionProgress(
          current,
          postAction === "transcribe_and_translate" ? { type: "scan-queued" } : { type: "backend-finished" },
        ),
      );
      addToast(
        postAction === "transcribe_and_translate"
          ? "Transcription complete. Translation jobs were queued."
          : "Transcription complete. Source subtitle was generated.",
        "success",
      );
    } catch (e: unknown) {
      const message = getErrorMessage(e);
      updateTranscriptionProgress(videoPath, (current) =>
        transitionManualTranscriptionProgress(current, { type: "error", message }),
      );
      addToast(`Transcription failed: ${message}`, "error");
    }
  };

  const handleRetryTranscription = async (attempt: TranscriptionHistoryEntry) => {
    setTranscribingPath(attempt.inputPath);
    try {
      const result = await retryTranscriptionMutation.mutateAsync(attempt.id);
      if (result.scanResult?.files) {
        setScanResult(result.scanResult.files);
        setScanResultMode(attempt.postAction === "transcribe_and_translate" ? "queued" : "preview");
        expandInterestingScanGroups(result.scanResult.files);
      }
      addToast("Transcription retried.", "success");
    } catch (e: unknown) {
      addToast(`Retry failed: ${getErrorMessage(e)}`, "error");
    } finally {
      setTranscribingPath(null);
    }
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

  // Status strip segments — double as filter tabs (L1)
  const statusSegments = [
    { key: "all", label: t("dashboard.filter.all"), count: jobs.length, color: "text-[var(--text)]", activeColor: "text-[var(--accent)]" },
    { key: "pending", label: t("dashboard.stat.pending"), count: pendingJobs.length, color: "text-[var(--yellow)]", activeColor: "text-[var(--yellow)]" },
    { key: "translating", label: t("dashboard.stat.translating"), count: activeJobs.length, color: "text-[var(--accent)]", activeColor: "text-[var(--accent)]" },
    { key: "done", label: t("dashboard.stat.done"), count: doneJobs.length, color: "text-[var(--green)]", activeColor: "text-[var(--green)]" },
    { key: "error", label: t("dashboard.stat.errors"), count: errorJobs.length, color: "text-[var(--red)]", activeColor: "text-[var(--red)]" },
  ];

  // Dashboard tabs: Queue / Transcription / Scan results
  const dashboardTabs = [
    { key: "queue" as DashboardTab, label: t("dashboard.tab.queue"), count: jobs.length },
    ...(transcriptionEnabled ? [{ key: "transcription" as DashboardTab, label: t("dashboard.tab.transcription"), count: transcriptionAttempts.length }] : []),
    ...(scanResult ? [{ key: "scan" as DashboardTab, label: t("dashboard.tab.scan"), count: scanResult.length }] : []),
  ];

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
          <ActionButton variant="ghost" size="sm" onClick={handlePreviewScan} busy={scanPreviewMutation.isPending} disabled={scanMutation.isPending}>
            {scanPreviewMutation.isPending ? t("dashboard.previewing") : t("dashboard.previewScan")}
          </ActionButton>
          <ActionButton variant="ghost" size="sm" onClick={handleScan} busy={scanMutation.isPending} disabled={scanPreviewMutation.isPending}>
            {scanMutation.isPending ? t("dashboard.scanning") : t("dashboard.scanFolders")}
          </ActionButton>
          <span className="mx-0.5 hidden h-[18px] w-px bg-[var(--border)] sm:block" />
          {queueRunning ? (
            <ActionButton variant="danger" size="sm" onClick={handleStop}>{t("dashboard.stop")}</ActionButton>
          ) : (
            <ActionButton variant="success" size="sm" onClick={handleRunAll} disabled={pendingJobs.length === 0}>{t("dashboard.runAll")}</ActionButton>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 space-y-4 p-3.5 md:p-[18px]">

        {/* L1: Hero band — StatusStrip (replaces 4 stat cards) */}
        {/* Desktop: flex-row layout xl:flex-row; mobile: stacked */}
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:gap-4">
          {/* Left: Status strip + active job */}
          <div className="min-w-0 flex-1 space-y-3">
            {/* StatusStrip — condensed stat row, each segment clickable to filter */}
            <StatusStrip
              segments={statusSegments}
              activeKey={statusFilter}
              onSelect={(key) => { setStatusFilter(key); setActiveTab("queue"); }}
            />
            {activeJob && <ActiveJobCard job={activeJob} pendingCount={pendingJobs.length} />}
          </div>
          {/* Right: quick-stat cards (kept for xl layout, condensed) — xl:w-[34rem] */}
          <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-2 xl:grid-cols-4 xl:w-[34rem]">
            <StatCard label={t("dashboard.stat.pending")} value={pendingJobs.length} color="text-[var(--yellow)]" onClick={() => { setStatusFilter("pending"); setActiveTab("queue"); }} />
            <StatCard label={t("dashboard.stat.translating")} value={activeJobs.length} color="text-[var(--accent)]" onClick={() => { setStatusFilter("translating"); setActiveTab("queue"); }} />
            <StatCard label={t("dashboard.stat.done")} value={doneJobs.length} color="text-[var(--green)]" onClick={() => { setStatusFilter("done"); setActiveTab("queue"); }} />
            <StatCard
              label={t("dashboard.stat.errors")}
              value={errorJobs.length}
              color="text-[var(--red)]"
              onClick={() => { setStatusFilter("error"); setActiveTab("queue"); }}
            />
          </div>
        </div>

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
              {quickChecks.map((step, idx) => (
                <div key={idx} className={`rounded-xl border p-3 ${step.done ? "border-[var(--green-border)] bg-[var(--green-dim)]" : "border-[var(--border)] bg-[var(--surface)]"}`}>
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
          {/* Tab header + filters */}
          <div className="space-y-3 border-b border-[var(--border)] px-3.5 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-[13.5px] font-semibold text-[var(--text)]">{t("app.queueSectionTitle")}</h2>
                <p className="text-pretty text-sm text-[var(--text-3)]">{t("app.queueSectionSubtitle")}</p>
              </div>
              {/* Dashboard tabs: Queue / Transcription / Scan results */}
              {dashboardTabs.length > 1 && (
                <div className="inline-flex w-fit gap-px overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-[2px]">
                  {dashboardTabs.map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => setActiveTab(tab.key)}
                      className={`whitespace-nowrap rounded-[6px] px-[11px] py-[3px] text-[12px] transition-colors ${activeTab === tab.key ? "bg-[var(--surface-3)] font-medium text-[var(--text)]" : "text-[var(--text-2)] hover:text-[var(--text)]"}`}
                    >
                      {tab.label}
                      {tab.count > 0 && <span className={`ml-1 text-[11px] ${tab.key === "error" ? "text-[var(--red)]" : "text-[var(--text-3)]"}`}>{tab.count}</span>}
                    </button>
                  ))}
                </div>
              )}
              {/* When only one tab, show status filter tabs */}
              {dashboardTabs.length === 1 && (
                <div className="inline-flex w-fit gap-px overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-[2px]">
                  {filterTabs.map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => setStatusFilter(tab.key)}
                      className={`whitespace-nowrap rounded-[6px] px-[11px] py-[3px] text-[12px] transition-colors ${statusFilter === tab.key ? "bg-[var(--surface-3)] font-medium text-[var(--text)]" : "text-[var(--text-2)] hover:text-[var(--text)]"}`}
                    >
                      {tab.label}
                      {tab.count > 0 && <span className={`ml-1 text-[11px] ${tab.key === "error" ? "text-[var(--red)]" : "text-[var(--text-3)]"}`}>{tab.count}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Queue tab: status filter tabs (when multi-tab mode) */}
            {activeTab === "queue" && dashboardTabs.length > 1 && (
              <div className="inline-flex w-fit gap-px overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-[2px]">
                {filterTabs.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setStatusFilter(tab.key)}
                    className={`whitespace-nowrap rounded-[6px] px-[11px] py-[3px] text-[12px] transition-colors ${statusFilter === tab.key ? "bg-[var(--surface-3)] font-medium text-[var(--text)]" : "text-[var(--text-2)] hover:text-[var(--text)]"}`}
                  >
                    {tab.label}
                    {tab.count > 0 && <span className={`ml-1 text-[11px] ${tab.key === "error" ? "text-[var(--red)]" : "text-[var(--text-3)]"}`}>{tab.count}</span>}
                  </button>
                ))}
              </div>
            )}

            {/* L3: Filters accordion (folder + target + clear) */}
            {activeTab === "queue" && (
              <Accordion title={t("dashboard.filtersLabel")} defaultOpen={hasQueueFilters}>
                <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <label className="min-w-0">
                    <span className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--text-3)]">{t("dashboard.queueFilterFolder")}</span>
                    <select
                      value={folderFilter}
                      onChange={(e) => setFolderFilter(e.target.value)}
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text)]"
                    >
                      <option value="all">{t("dashboard.queueFilterAllFolders")}</option>
                      {folderOptions.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
                    </select>
                  </label>
                  <label className="min-w-0">
                    <span className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--text-3)]">{t("dashboard.queueFilterTarget")}</span>
                    <select
                      value={targetFilter}
                      onChange={(e) => setTargetFilter(e.target.value)}
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text)]"
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
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)] disabled:opacity-40"
                    >
                      {t("dashboard.clearQueueFilters")}
                    </button>
                  </div>
                </div>
                {/* Bulk action buttons — kept accessible here in the filters accordion */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSelectVisiblePending}
                    disabled={visiblePendingIds.length === 0}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)] disabled:opacity-40"
                  >
                    {t("dashboard.selectVisiblePending", { count: visiblePendingIds.length })}
                  </button>
                  <button
                    type="button"
                    onClick={handleRetryVisibleErrors}
                    disabled={visibleErrorIds.length === 0 || retrySelectedMutation.isPending}
                    className="rounded-lg border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-3 py-2 text-xs font-medium text-[var(--yellow)] disabled:opacity-40"
                  >
                    {t("dashboard.retryVisibleErrors", { count: visibleErrorIds.length })}
                  </button>
                  <button
                    type="button"
                    onClick={handleRetranslateVisible}
                    disabled={visibleRetranslatableIds.length === 0 || forceSelectedMutation.isPending}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)] disabled:opacity-40"
                  >
                    {t("dashboard.retranslateVisible", { count: visibleRetranslatableIds.length })}
                  </button>
                  <button
                    type="button"
                    onClick={handleClearAll}
                    disabled={jobs.length === 0}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)] disabled:opacity-40"
                  >
                    {t("dashboard.clearAll")}
                  </button>
                </div>
              </Accordion>
            )}
          </div>

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
              <button
                type="button"
                onClick={handleRunSelected}
                disabled={startSelectedMutation.isPending}
                className="rounded-lg bg-[var(--green)] px-3 py-2 text-xs font-semibold text-black disabled:opacity-50"
              >
                {t("dashboard.runSelected", { count: selectedPendingCount })}
              </button>
            )}
            <button
              type="button"
              onClick={handleDeleteSelected}
              disabled={deleteSelectedMutation.isPending}
              className="rounded-lg border border-[var(--red-border)] bg-transparent px-3 py-2 text-xs font-medium text-[var(--red)] disabled:opacity-50"
            >
              {t("dashboard.deleteSelected")}
            </button>
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
            )
          )}

          {activeTab === "transcription" && transcriptionEnabled && (
            <div className="p-3.5">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-[13.5px] font-semibold text-[var(--text)]">Recent transcriptions</h2>
                  <p className="text-[11px] text-[var(--text-3)]">History is JSON-backed and safe to keep outside the jobs queue.</p>
                </div>
                <span className="text-[11px] text-[var(--text-3)]">{transcriptionAttempts.length} shown</span>
              </div>
              {transcriptionAttempts.length === 0 ? (
                <div className="text-[13px] text-[var(--text-3)]">No transcription attempts yet.</div>
              ) : (
                <div className="space-y-2">
                  {transcriptionAttempts.map((attempt) => {
                    const title = attempt.inputPath.split(/[\\/]/).pop() || attempt.inputPath;
                    const activeRetry = transcribingPath === attempt.inputPath && retryTranscriptionMutation.isPending;
                    return (
                      <div key={attempt.id} className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 md:flex-row md:items-center md:justify-between">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--text)]">{title}</div>
                          <div className="mt-1 text-[11px] text-[var(--text-3)]">
                            {attempt.model} • {attempt.language} • {attempt.outputFormat.toUpperCase()} • {attempt.postAction === "transcribe_and_translate" ? "queue translate" : "transcribe only"}
                          </div>
                          <div className="mt-1 text-[11px] text-[var(--text-3)]">
                            {attempt.status === "failed" ? (attempt.errorSummary || "Transcription failed") : attempt.finishedAt || attempt.startedAt}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full border px-3 py-1 text-[11px] ${attempt.status === "succeeded" ? "border-[var(--green-border)] bg-[var(--green-dim)] text-[var(--green)]" : attempt.status === "failed" ? "border-[var(--red-border)] bg-[var(--red-dim)] text-[var(--red)]" : "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]"}`}>
                            {attempt.status}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRetryTranscription(attempt)}
                            disabled={activeRetry || transcribeMutation.isPending}
                            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)] disabled:opacity-40"
                          >
                            {activeRetry ? "Retrying…" : "Retry"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "scan" && scanResult && (
            <div className="p-3.5">
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
                onTranscribe={handleTranscribe}
                transcriptionEnabled={transcriptionEnabled}
                transcriptionProgressByPath={transcriptionProgressByPath}
                isQueueing={scanMutation.isPending}
                newJobsCount={scanResult.flatMap((file) => file.subtitles.flatMap((sub) => sub.tasks)).filter((task) => task.status === "new").length}
              />
            </div>
          )}
        </section>
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
        <ModalShell
          title={t("dashboard.scanConfirm.title")}
          onClose={() => setScanPlan(null)}
          overlayClassName="fixed inset-0 z-50 bg-black/70 p-4"
          panelClassName="mx-auto mt-16 w-full max-w-xl rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6"
        >
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              onClick={() => setScanPlan(null)}
              className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-sm text-[var(--text-2)] hover:text-[var(--text)]"
              aria-label={t("common.close")}
              title={t("common.close")}
            >
              ×
            </button>
          </div>
          <p className="mt-2 text-[13px] text-[var(--text-2)]">{t("dashboard.scanConfirm.summary", { subtitles: scanPlan.totalSubtitles, jobs: scanPlan.newJobs })}</p>
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div className="text-xs text-[var(--text-3)]">{t("dashboard.scanConfirm.topFolders")}</div>
            <div className="mt-1 text-[13px] text-[var(--text)]">{scanPlan.topFolders.length > 0 ? scanPlan.topFolders.join(", ") : t("dashboard.scanConfirm.none")}</div>
          </div>
          {/* sm:col-span-2 grid for the confirm buttons on small screens */}
          <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
            <button onClick={() => setScanPlan(null)} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-2)] sm:col-span-1">{t("common.cancel")}</button>
            <button onClick={confirmQueueScan} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white sm:col-span-1">{t("dashboard.scanConfirm.proceed")}</button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
