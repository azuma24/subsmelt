import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { str } from "../../lib/settings-value";
import {
  useIsMobile,
  useJobsQuery,
  useLibraryQuery,
  useMutationWithInvalidation,
  useQueueStatusQuery,
  useSettingsQuery,
  useTranscriptionHistoryQuery,
} from "../../hooks";
import { useToast } from "../../ui/Toast";
import type { Job } from "../../types";
import { ActionButton, PageHeader } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { RefreshButton } from "../../ui/RefreshButton";
import { LlmStatusPopover } from "../../app/LlmStatusPopover";
import { PreviewOverlay } from "../dashboard/PreviewOverlay";
import { JobDetailsDrawer } from "../dashboard/JobDetailsDrawer";
import { TranscriptionHistoryPanel } from "../dashboard/TranscriptionHistoryPanel";
import { useManualTranscription } from "../dashboard/useManualTranscription";
import { toLibraryItems } from "./library-model";
import {
  dashboardSearchParams,
  parseDashboardParams,
  type DashboardParams,
  type DashboardView,
} from "./dashboard-params";
import { FilesView } from "./FilesView";
import { JobsView } from "./JobsView";
import { QueueBand } from "./QueueBand";
import { QuickStart } from "./QuickStart";
import { ScanConfirmModal } from "./ScanConfirmModal";
import { useScanFlow } from "./useScanFlow";

const TRANSCRIPTION_HISTORY_LIMIT = 8;

/** The home page: the queue, setup, and one of three views (files, jobs, transcriptions) chosen in the URL. */
export function LibraryPage() {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const libraryQuery = useLibraryQuery();
  const jobsQuery = useJobsQuery();
  const settingsQuery = useSettingsQuery();
  const queueStatusQuery = useQueueStatusQuery();
  const transcription = useManualTranscription();
  const scan = useScanFlow();
  const startQueueMutation = useMutationWithInvalidation(() => api.startQueue());
  const stopQueueMutation = useMutationWithInvalidation(() => api.stopQueue());
  const [previewJobId, setPreviewJobId] = useState<number | null>(null);
  const [previewSearch, setPreviewSearch] = useState("");
  const [detailsJobId, setDetailsJobId] = useState<number | null>(null);

  const settings = settingsQuery.data || {};
  const transcriptionEnabled = str(settings.transcription_enabled, "0") === "1";
  const autoTranslate = str(settings.auto_translate, "1") === "1";
  const transcriptionHistoryQuery = useTranscriptionHistoryQuery(transcriptionEnabled, TRANSCRIPTION_HISTORY_LIMIT);
  const transcriptionAttempts = transcriptionHistoryQuery.data?.attempts || [];

  const params = parseDashboardParams(searchParams);
  // A link or bookmark can name the Transcriptions view while transcription is off.
  const view: DashboardView = params.view === "transcriptions" && !transcriptionEnabled ? "files" : params.view;
  const setParams = useCallback(
    (patch: Partial<DashboardParams>) =>
      setSearchParams((current) => dashboardSearchParams({ ...parseDashboardParams(current), ...patch }), {
        replace: true,
      }),
    [setSearchParams],
  );

  const jobs: Job[] = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data]);
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const queueRunning = Boolean(queueStatusQuery.data?.running ?? jobsQuery.data?.queueRunning ?? false);
  const currentJobId = queueStatusQuery.data?.currentJobId ?? jobsQuery.data?.currentJobId ?? null;
  const mediaDir = str(settings._media_dir, "/media");
  const items = useMemo(() => toLibraryItems(libraryQuery.data?.files ?? [], mediaDir), [libraryQuery.data, mediaDir]);

  const reportFailure = (e: unknown) =>
    addToast(e instanceof Error ? e.message : t("dashboard.toast.actionFailed"), "error");
  const runAll = async () => {
    try {
      await startQueueMutation.mutateAsync();
      addToast(t("dashboard.toast.queueStarted"), "info");
    } catch (e) {
      reportFailure(e);
    }
  };
  const stop = async () => {
    try {
      await stopQueueMutation.mutateAsync();
    } catch (e) {
      reportFailure(e);
    }
  };

  const openJob = useCallback(
    (jobId: number) => {
      setParams({ view: "jobs" });
      setDetailsJobId(jobId);
    },
    [setParams],
  );
  const openDetails = useCallback((job: Job) => setDetailsJobId(job.id), []);
  const openLogs = useCallback((jobId: number) => navigate(`/settings/logs?job=${jobId}`), [navigate]);
  // Read live so the drawer follows progress and status instead of showing the
  // row as it was when opened; it closes on its own if the job is deleted.
  const detailsJob = detailsJobId === null ? null : (jobsById.get(detailsJobId) ?? null);

  const tabs: { key: DashboardView; label: string; count?: number }[] = [
    { key: "files", label: t("library.view.files") },
    { key: "jobs", label: t("library.view.jobs"), count: jobs.length },
    ...(transcriptionEnabled
      ? [
          {
            key: "transcriptions" as const,
            label: t("library.view.transcriptions"),
            count: transcriptionAttempts.length,
          },
        ]
      : []),
  ];
  const files = libraryQuery.data?.files;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Phones show "Library" in the bottom tab bar and have no sidebar, so the
          title is screen-reader only there and the LLM status takes its place. */}
      <PageHeader
        title={t("nav.library")}
        titleHiddenBelowMd
        subtitle={files && files.length > 0 ? t("library.summary.files", { count: items.length }) : undefined}
        middle={isMobile ? <LlmStatusPopover placement="below" /> : undefined}
        actions={
          <>
            <RefreshButton busy={libraryQuery.isFetching} onClick={() => void libraryQuery.refetch()} />
            <Link
              to="/convert"
              className="inline-flex min-h-touch items-center gap-2 rounded-sm border border-border bg-surface px-3 text-sm font-medium text-text transition-colors duration-fast hover:bg-surface-raised"
            >
              <Icon name="upload" />
              {t("library.upload")}
            </Link>
            <ActionButton size="md" onClick={() => void scan.start()} busy={scan.busy}>
              {scan.busy ? t("library.scanning") : t("library.scan")}
            </ActionButton>
          </>
        }
      />

      <QueueBand
        jobs={jobs}
        queueRunning={queueRunning}
        onRunAll={() => void runAll()}
        onStop={() => void stop()}
        busy={startQueueMutation.isPending || stopQueueMutation.isPending}
      />
      <QuickStart
        jobs={jobs}
        queueRunning={queueRunning}
        onScan={() => void scan.start()}
        onRunAll={() => void runAll()}
      />
      {!autoTranslate && (
        <p className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted">
          {t("dashboard.scanAutoTranslateOff")}
        </p>
      )}

      <div role="tablist" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4">
        {tabs.map((tab) => {
          const selected = tab.key === view;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setParams({ view: tab.key })}
              className={`-mb-px inline-flex min-h-touch shrink-0 items-center gap-1 border-b-2 px-3 text-sm transition-colors duration-fast ${selected ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text"}`}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && <span className="text-xs text-faint">{tab.count}</span>}
            </button>
          );
        })}
      </div>

      {view === "files" && (
        <FilesView
          items={items}
          jobsById={jobsById}
          filter={params.filter}
          onFilterChange={(filter) => setParams({ filter })}
          transcription={transcription}
          onPreview={setPreviewJobId}
          onOpenJob={openJob}
        />
      )}
      {view === "jobs" && (
        <JobsView
          status={params.status}
          onStatusChange={(status) => setParams({ status })}
          queueRunning={queueRunning}
          currentJobId={currentJobId}
          onPreview={setPreviewJobId}
          onOpenDetails={openDetails}
          onOpenLogs={openLogs}
        />
      )}
      {view === "transcriptions" && (
        <section aria-label={t("library.view.transcriptions")} className="flex-1">
          <TranscriptionHistoryPanel
            attempts={transcriptionAttempts}
            transcribingPath={transcription.transcribingPath}
            isRetryPending={transcription.isRetryPending}
            isTranscribePending={transcription.isTranscribePending}
            onRetry={transcription.handleRetryTranscription}
          />
        </section>
      )}

      <JobDetailsDrawer
        job={detailsJob}
        open={detailsJob !== null}
        onClose={() => setDetailsJobId(null)}
        onOpenLogs={openLogs}
      />
      {scan.plan && (
        <ScanConfirmModal scanPlan={scan.plan} onClose={scan.cancel} onConfirm={() => void scan.confirm()} t={t} />
      )}
      {previewJobId !== null && (
        <PreviewOverlay
          jobId={previewJobId}
          previewSearch={previewSearch}
          setPreviewSearch={setPreviewSearch}
          onClose={() => {
            setPreviewJobId(null);
            setPreviewSearch("");
          }}
        />
      )}
    </div>
  );
}
