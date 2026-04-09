import { NavLink } from "react-router-dom";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useJobsQuery, useMutationWithInvalidation, useSettingsQuery, useTasksQuery } from "../../hooks";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import type { JobRow, ScannedFile } from "../../types";
import { ActionButton, EmptyHint, StatCard } from "../../ui/primitives";
import { ActiveJobCard } from "./ActiveJobCard";
import { JobsTableDesktop } from "./JobsTableDesktop";
import { JobCardMobile } from "./JobCardMobile";
import { PreviewOverlay } from "./PreviewOverlay";
import { ScanResultsPanel, getScanGroupName, type ScanFilter } from "./ScanResultsPanel";

export function DashboardPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const jobsQuery = useJobsQuery();
  const tasksQuery = useTasksQuery();
  const settingsQuery = useSettingsQuery();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scanResult, setScanResult] = useState<ScannedFile[] | null>(null);
  const [scanListFilter, setScanListFilter] = useState<ScanFilter>("all");
  const [scanSearch, setScanSearch] = useState("");
  const [expandedScanGroups, setExpandedScanGroups] = useState<Set<string>>(new Set());
  const [previewJobId, setPreviewJobId] = useState<number | null>(null);
  const [previewSearch, setPreviewSearch] = useState("");
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const scanMutation = useMutationWithInvalidation(() => api.scanFolder());
  const startQueueMutation = useMutationWithInvalidation(() => api.startQueue());
  const startSelectedMutation = useMutationWithInvalidation((ids: number[]) => api.startQueue(ids));
  const stopQueueMutation = useMutationWithInvalidation(() => api.stopQueue());
  const clearJobsMutation = useMutationWithInvalidation(() => api.clearJobs());

  const jobs: JobRow[] = jobsQuery.data?.jobs || [];
  const queueRunning = jobsQuery.data?.queueRunning || false;
  const currentJobId = jobsQuery.data?.currentJobId ?? null;
  const settings = settingsQuery.data || {};
  const taskCount = tasksQuery.data?.length || 0;
  const needsSetup = (!settings.llm_endpoint || settings.llm_endpoint === "http://localhost:8000/v1") && !settings.api_key;

  const pendingJobs = jobs.filter((j) => j.status === "pending");
  const selectedPendingCount = pendingJobs.filter((j) => selectedIds.has(j.id)).length;
  const activeJobs = jobs.filter((j) => j.status === "translating");
  const doneJobs = jobs.filter((j) => j.status === "done");
  const errorJobs = jobs.filter((j) => j.status === "error");
  const activeJob = activeJobs[0];
  const filteredJobs = statusFilter === "all" ? jobs : jobs.filter((j) => j.status === statusFilter);

  const filterTabs = [
    { key: "all", label: t("dashboard.filter.all"), count: jobs.length },
    { key: "pending", label: t("dashboard.filter.pending"), count: pendingJobs.length },
    { key: "translating", label: t("dashboard.filter.translating"), count: activeJobs.length },
    { key: "done", label: t("dashboard.filter.done"), count: doneJobs.length },
    { key: "error", label: t("dashboard.filter.error"), count: errorJobs.length },
  ];

  const handleScan = async () => {
    try {
      const result = await scanMutation.mutateAsync();
      setScanResult(result.files);
      const initialGroups = new Set<string>();
      result.files.forEach((file: ScannedFile) => {
        const group = getScanGroupName(file);
        const hasNew = file.subtitles.some((sub) => sub.tasks.some((task) => task.status === "new" || task.status === "pending"));
        const missing = file.videoName && file.subtitles.length === 0;
        const orphan = !file.videoName;
        if (hasNew || missing || orphan) initialGroups.add(group);
      });
      setExpandedScanGroups(initialGroups);
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
    const pendingSelected = pendingJobs.filter((j) => selectedIds.has(j.id)).map((j) => j.id);
    if (pendingSelected.length === 0) return;
    await startSelectedMutation.mutateAsync(pendingSelected);
    addToast(t("dashboard.toast.runSelectedStarted", { count: pendingSelected.length }), "info");
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
      addToast(t("dashboard.toast.jobsCleared"), "info");
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-6">
      <div className="space-y-6">
        <section className="rounded-3xl border border-gray-800 bg-gradient-to-br from-gray-900 to-gray-950 p-5 md:p-6">
          <div className={`flex ${isMobile ? "flex-col gap-4" : "items-start justify-between gap-4"}`}>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">SubSmelt</h1>
            </div>
            <div className={`flex ${isMobile ? "grid grid-cols-2 gap-2" : "flex-wrap gap-2"}`}>
              <ActionButton onClick={handleScan} busy={scanMutation.isPending}>
                {scanMutation.isPending ? t("dashboard.scanning") : t("dashboard.scanFolders")}
              </ActionButton>
              {!queueRunning ? (
                <>
                  <ActionButton variant="success" onClick={handleRunAll} disabled={pendingJobs.length === 0}>{t("dashboard.runAll")}</ActionButton>
                  {selectedPendingCount > 0 && (
                    <ActionButton variant="primary" onClick={handleRunSelected}>
                      {t("dashboard.runSelected", { count: selectedPendingCount })}
                    </ActionButton>
                  )}
                </>
              ) : (
                <ActionButton variant="danger" onClick={handleStop}>{t("dashboard.stop")}</ActionButton>
              )}
              {jobs.length > 0 && <ActionButton variant="ghost" onClick={handleClearAll}>{t("dashboard.clearAll")}</ActionButton>}
            </div>
          </div>
          {(needsSetup || taskCount === 0 || (jobs.length === 0 && !scanResult)) && (
            <div className="mt-5 rounded-2xl border border-blue-800/40 bg-blue-900/15 p-4">
              <p className="mb-3 text-sm font-medium text-blue-300">{t("dashboard.onboarding.title")}</p>
              <div className="space-y-2">
                <StepRow done={!needsSetup} label={t("dashboard.onboarding.step1")} action={t("dashboard.onboarding.step1Action")} to="/settings" />
                <StepRow done={taskCount > 0} label={t("dashboard.onboarding.step2")} action={t("dashboard.onboarding.step2Action")} to="/tasks" />
                <StepRow done={jobs.length > 0 || !!scanResult} label={t("dashboard.onboarding.step3")} action={t("dashboard.onboarding.step3Action")} onClick={handleScan} />
              </div>
            </div>
          )}
        </section>

        {activeJob && <ActiveJobCard job={activeJob} pendingCount={pendingJobs.length} />}

        <section className={`grid gap-3 ${isMobile ? "grid-cols-2" : "grid-cols-4"}`}>
          <StatCard label={t("dashboard.stat.pending")} value={pendingJobs.length} color="text-yellow-400" />
          <StatCard label={t("dashboard.stat.translating")} value={activeJobs.length} color="text-blue-400" />
          <StatCard label={t("dashboard.stat.done")} value={doneJobs.length} color="text-green-400" />
          <StatCard label={t("dashboard.stat.errors")} value={errorJobs.length} color="text-red-400" />
        </section>

        <section className="rounded-3xl border border-gray-800 bg-gray-900/80 overflow-hidden">
          <div className="border-b border-gray-800 px-4 py-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">{t("app.queueSectionTitle")}</h2>
              <p className="text-xs text-gray-500">{t("app.queueSectionSubtitle")}</p>
            </div>
            <div className="flex gap-2 overflow-x-auto">
              {filterTabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setStatusFilter(tab.key)}
                  className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${statusFilter === tab.key ? "bg-blue-600/15 text-white border border-blue-500/30" : "bg-gray-800 text-gray-400"}`}
                >
                  {tab.label} {tab.count > 0 && <span className="ml-1 opacity-70">{tab.count}</span>}
                </button>
              ))}
            </div>
          </div>
          {isMobile ? (
            <div className="space-y-3 p-4">
              {filteredJobs.length === 0 && <EmptyHint text={t("dashboard.noJobsMatchFilter")} />}
              {filteredJobs.map((job) => (
                <JobCardMobile key={job.id} job={job} currentJobId={currentJobId} expandedErrors={expandedErrors} setExpandedErrors={setExpandedErrors} onPreview={setPreviewJobId} />
              ))}
            </div>
          ) : (
            <JobsTableDesktop jobs={filteredJobs} currentJobId={currentJobId} expandedErrors={expandedErrors} setExpandedErrors={setExpandedErrors} selectedIds={selectedIds} setSelectedIds={setSelectedIds} onPreview={setPreviewJobId} />
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
