import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { JobRow, ManualTranscriptionStage, ScannedFile, TaskStatus } from "../../types";
import { STATUS_ICON } from "../../app/constants";
import { isManualTranscriptionBusy, type ManualTranscriptionProgress, type TranscribePostAction } from "./transcription-progress";

export type ScanFilter = "all" | "new" | "missing" | "orphans";

interface ScanResultsPanelProps {
  files: ScannedFile[];
  filter: ScanFilter;
  setFilter: (v: ScanFilter) => void;
  search: string;
  setSearch: (v: string) => void;
  expandedGroups: Set<string>;
  setExpandedGroups: Dispatch<SetStateAction<Set<string>>>;
  jobsById: Map<number, JobRow>;
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
  mode: "preview" | "queued";
  onQueueAll: () => void;
  onTranscribe?: (videoPath: string, postAction: TranscribePostAction) => void;
  onCancelTranscribe?: (videoPath: string) => void;
  selectedVideoPaths?: Set<string>;
  setSelectedVideoPaths?: Dispatch<SetStateAction<Set<string>>>;
  onBatchTranscribe?: (videoPaths: string[], postAction: TranscribePostAction) => void;
  transcriptionEnabled?: boolean;
  transcriptionProgressByPath?: Record<string, ManualTranscriptionProgress>;
  isQueueing: boolean;
  newJobsCount: number;
  mediaDir?: string;
}

export function getScanGroupName(file: ScannedFile, mediaDir?: string): string {
  const path = file.videoPath || file.subtitles[0]?.srtPath || "";
  // Derive the top-level group from the configured media directory so installs
  // with a non-default root (e.g. /mnt/media) group correctly. Fall back to the
  // historical "/media/" marker when mediaDir is unknown so behavior is unchanged.
  const marker = mediaDir ? `${mediaDir.replace(/\/+$/, "")}/` : "/media/";
  const idx = path.indexOf(marker);
  if (idx >= 0) {
    const rest = path.slice(idx + marker.length);
    return rest.split("/")[0] || "root";
  }
  return file.videoName ? "library" : "orphans";
}

function getTaskStatus(task: TaskStatus, jobsById: Map<number, JobRow>): string {
  const liveJob = task.jobId === null ? null : jobsById.get(task.jobId);
  if (liveJob) return liveJob.status;
  if (task.jobId !== null && ["pending", "translating", "error"].includes(task.status)) return "new";
  return task.status;
}

function getPendingJobIds(file: ScannedFile, jobsById: Map<number, JobRow>): number[] {
  return file.subtitles.flatMap((sub) =>
    sub.tasks
      .filter((task) => task.jobId !== null && jobsById.get(task.jobId)?.status === "pending")
      .map((task) => task.jobId as number)
  );
}

function stageTone(stage: ManualTranscriptionStage): string {
  switch (stage) {
    case "complete":
      return "text-green-300";
    case "skipped":
      return "text-yellow-300";
    case "failed":
      return "text-red-300";
    case "cancelled":
      return "text-gray-400";
    case "cancelling":
      return "text-yellow-300";
    default:
      return "text-blue-300";
  }
}

function stageText(
  progress: ManualTranscriptionProgress,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (progress.stage) {
    case "preflighting":
      return t("scan.transcription.preflighting");
    case "transcribing":
      return typeof progress.pct === "number"
        ? t("scan.transcription.progressPct", { pct: Math.round(progress.pct) })
        : t("scan.transcription.transcribing");
    case "queueing":
      return t("scan.transcription.queueing");
    case "complete":
      return progress.postAction === "transcribe_and_translate"
        ? t("scan.transcription.completeQueued")
        : t("scan.transcription.completeSubtitle");
    case "skipped":
      return progress.message || t("scan.transcription.skipped");
    case "failed":
      return progress.message || t("scan.transcription.failed");
    case "cancelling":
      return t("scan.transcription.cancelling");
    case "cancelled":
      return t("scan.transcription.cancelled");
  }
}

export function ScanResultsPanel({
  files,
  filter,
  setFilter,
  search,
  setSearch,
  expandedGroups,
  setExpandedGroups,
  jobsById,
  selectedIds,
  setSelectedIds,
  mode,
  onQueueAll,
  onTranscribe,
  onCancelTranscribe,
  selectedVideoPaths,
  setSelectedVideoPaths,
  onBatchTranscribe,
  transcriptionEnabled = false,
  transcriptionProgressByPath = {},
  isQueueing,
  newJobsCount,
  mediaDir,
}: ScanResultsPanelProps) {
  const { t } = useTranslation();
  const selectedPaths = selectedVideoPaths ?? new Set<string>();
  const batchEnabled = transcriptionEnabled && Boolean(onBatchTranscribe && setSelectedVideoPaths);

  const filteredFiles = useMemo(() => {
    const query = search.toLowerCase();
    return files.filter((file) => {
      const matchesSearch = !query || `${file.videoName || ""} ${file.subtitles.map((s) => s.srtName).join(" ")}`.toLowerCase().includes(query);
      if (!matchesSearch) return false;
      if (filter === "orphans") return !file.videoName;
      if (filter === "missing") return !!file.videoName && file.subtitles.length === 0;
      if (filter === "new") return file.subtitles.some((sub) => sub.tasks.some((task) => {
        const status = getTaskStatus(task, jobsById);
        return status === "new" || status === "pending";
      }));
      return true;
    });
  }, [files, filter, jobsById, search]);

  const groups = useMemo(() => {
    const grouped = new Map<string, ScannedFile[]>();
    filteredFiles.forEach((file) => {
      const group = getScanGroupName(file, mediaDir);
      grouped.set(group, [...(grouped.get(group) || []), file]);
    });
    return Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredFiles, mediaDir]);
  // Only act on selections that are still visible under the current filter/search,
  // so the bulk action never transcribes files the user can no longer see.
  const visibleSelectedPaths = useMemo(() => {
    const visible = new Set(filteredFiles.map((f) => f.videoPath).filter(Boolean) as string[]);
    return Array.from(selectedPaths).filter((p) => visible.has(p));
  }, [filteredFiles, selectedPaths]);

  const toggleGroup = (group: string) => setExpandedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });

  return (
    <section className="rounded-3xl border border-gray-800 bg-gray-900/80 overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-gray-800 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-gray-300">{t("dashboard.library")}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${mode === "preview" ? "bg-blue-900/30 text-blue-300" : "bg-green-900/30 text-green-300"}`}>
              {mode === "preview" ? t("app.scanPreviewBadge") : t("app.scanQueuedBadge")}
            </span>
          </div>
          <p className="text-xs text-gray-500">{mode === "preview" ? t("app.scanPreviewHint") : t("app.scanGroupedHint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">{t("dashboard.entries", { count: filteredFiles.length })}</span>
          {batchEnabled && visibleSelectedPaths.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onBatchTranscribe?.(visibleSelectedPaths, "transcribe_only")}
                className="rounded-lg bg-gray-700 px-3 py-2 text-xs font-medium text-gray-100"
              >
                {t("scan.transcription.batchTranscribe", { count: visibleSelectedPaths.length })}
              </button>
              <button
                type="button"
                onClick={() => onBatchTranscribe?.(visibleSelectedPaths, "transcribe_and_translate")}
                className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white"
              >
                {t("scan.transcription.batchTranscribeTranslate", { count: visibleSelectedPaths.length })}
              </button>
              <button
                type="button"
                onClick={() => setSelectedVideoPaths?.(new Set())}
                className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400"
              >
                {t("scan.transcription.clearSelection")}
              </button>
            </div>
          )}
          {mode === "preview" && (
            <button
              type="button"
              onClick={onQueueAll}
              disabled={isQueueing || newJobsCount === 0}
              className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
            >
              {isQueueing ? t("dashboard.scanning") : t("dashboard.queuePreview", { count: newJobsCount })}
            </button>
          )}
        </div>
      </div>
      <div className="border-b border-gray-800 px-4 py-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          {([
            { key: "all", label: t("app.scanFilterAll") },
            { key: "new", label: t("app.scanFilterNew") },
            { key: "missing", label: t("app.scanFilterMissing") },
            { key: "orphans", label: t("app.scanFilterOrphans") },
          ] as const).map((chip) => (
            <button
              key={chip.key}
              onClick={() => setFilter(chip.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${filter === chip.key ? "bg-blue-600/15 text-white border border-blue-500/30" : "bg-gray-800 text-gray-400"}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("app.scanSearchPlaceholder")}
          className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200"
        />
      </div>
      <div className="max-h-[50vh] overflow-y-auto">
        {groups.length === 0 && <div className="px-4 py-6 text-center text-gray-500 text-sm"><div>{t("app.scanNoMatch")}</div><div className="mt-1 text-xs text-gray-600">{t("dashboard.emptyScanHint")}</div></div>}
        <div className="divide-y divide-gray-800/50">
          {groups.map(([group, groupFiles]) => {
            const expanded = expandedGroups.has(group);
            return (
              <div key={group}>
                <button onClick={() => toggleGroup(group)} className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-800/30">
                  <div>
                    <div className="text-sm font-medium text-gray-200">{group}</div>
                    <div className="text-[11px] text-gray-500">{t("app.scanItems", { count: groupFiles.length })}</div>
                  </div>
                  <div className="text-xs text-gray-500">{expanded ? t("app.scanHide") : t("app.scanShow")}</div>
                </button>
                {expanded && (
                  <div className="border-t border-gray-800/60 bg-gray-950/30">
                    {groupFiles.map((file, i) => (
                      <CompactScanFileRow
                        key={`${group}-${i}`}
                        file={file}
                        jobsById={jobsById}
                        selectedIds={selectedIds}
                        setSelectedIds={setSelectedIds}
                        onTranscribe={onTranscribe}
                        onCancelTranscribe={onCancelTranscribe}
                        selectedVideoPaths={selectedPaths}
                        setSelectedVideoPaths={setSelectedVideoPaths}
                        batchEnabled={batchEnabled}
                        transcriptionEnabled={transcriptionEnabled}
                        transcriptionProgressByPath={transcriptionProgressByPath}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function CompactScanFileRow({
  file,
  jobsById,
  selectedIds,
  setSelectedIds,
  onTranscribe,
  onCancelTranscribe,
  selectedVideoPaths,
  setSelectedVideoPaths,
  batchEnabled,
  transcriptionEnabled,
  transcriptionProgressByPath,
}: {
  file: ScannedFile;
  jobsById: Map<number, JobRow>;
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
  onTranscribe?: (videoPath: string, postAction: TranscribePostAction) => void;
  onCancelTranscribe?: (videoPath: string) => void;
  selectedVideoPaths: Set<string>;
  setSelectedVideoPaths?: Dispatch<SetStateAction<Set<string>>>;
  batchEnabled: boolean;
  transcriptionEnabled: boolean;
  transcriptionProgressByPath: Record<string, ManualTranscriptionProgress>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasNew = file.subtitles.some((sub) => sub.tasks.some((task) => {
    const status = getTaskStatus(task, jobsById);
    return status === "new" || status === "pending";
  }));
  const missing = file.videoName && file.subtitles.length === 0;
  const orphan = !file.videoName;
  const pendingJobIds = getPendingJobIds(file, jobsById);
  const selectedPendingCount = pendingJobIds.filter((id) => selectedIds.has(id)).length;
  const allPendingSelected = pendingJobIds.length > 0 && selectedPendingCount === pendingJobIds.length;
  const somePendingSelected = selectedPendingCount > 0 && !allPendingSelected;
  const progress = file.videoPath ? transcriptionProgressByPath[file.videoPath] : undefined;
  const isBusy = isManualTranscriptionBusy(progress);
  // Cancel is only meaningful while the backend is actively transcribing (a
  // stream is open); preflight/cancelling phases have nothing to abort yet.
  const canCancel = Boolean(
    onCancelTranscribe && file.videoPath && progress && progress.stage === "transcribing",
  );

  const togglePendingJobs = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPendingSelected) pendingJobIds.forEach((id) => next.delete(id));
      else pendingJobIds.forEach((id) => next.add(id));
      return next;
    });
  };

  return (
    <div className="border-b border-gray-800/50 last:border-b-0">
      <div className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-800/20 ${allPendingSelected || somePendingSelected ? "bg-blue-950/20" : ""}`}>
        {batchEnabled && file.videoPath && (
          <input
            type="checkbox"
            checked={selectedVideoPaths.has(file.videoPath)}
            disabled={isBusy}
            onChange={() => {
              const vp = file.videoPath as string;
              setSelectedVideoPaths?.((prev) => {
                const next = new Set(prev);
                if (next.has(vp)) next.delete(vp); else next.add(vp);
                return next;
              });
            }}
            className="h-4 w-4 shrink-0 accent-green-500"
            title={t("scan.transcription.selectForTranscription")}
            aria-label={t("scan.transcription.selectForTranscription")}
          />
        )}
        {pendingJobIds.length > 0 && (
          <input
            type="checkbox"
            checked={allPendingSelected}
            ref={(el) => {
              if (el) el.indeterminate = somePendingSelected;
            }}
            onChange={togglePendingJobs}
            className="h-4 w-4 shrink-0 accent-blue-500"
            aria-label={t("app.scanSelectPending")}
          />
        )}
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-gray-200">
              <span className="text-gray-500">{file.videoName ? "🎬" : "📝"}</span>
              <span className="truncate font-medium">{file.videoName || t("dashboard.orphanSubtitle")}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-gray-500">
              {hasNew && <span className="rounded-full bg-blue-900/20 px-2 py-0.5 text-blue-300">{t("app.scanNewJobs")}</span>}
              {pendingJobIds.length > 0 && <span className="rounded-full bg-yellow-900/20 px-2 py-0.5 text-yellow-300">{t("app.scanPendingJobs", { count: pendingJobIds.length })}</span>}
              {missing && <span className="rounded-full bg-yellow-900/20 px-2 py-0.5 text-yellow-300">{t("app.scanMissingSubtitles")}</span>}
              {orphan && <span className="rounded-full bg-gray-800 px-2 py-0.5 text-gray-300">{t("app.scanOrphan")}</span>}
              <span>{t("app.subtitleCount", { count: file.subtitles.length })}</span>
              {progress && <span className={stageTone(progress.stage)}>{stageText(progress, t)}</span>}
            </div>
          </div>
        </button>
        <button type="button" onClick={() => setOpen(!open)} className="text-xs text-gray-500">{open ? t("app.scanHide") : t("app.scanDetails")}</button>
      </div>
      {open && (
        <div className="px-4 pb-4">
          <div className="mb-2 flex items-center justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full border border-gray-700 bg-gray-900/70 px-2 py-1 text-xs text-gray-300 hover:text-white"
              aria-label={t("common.close")}
              title={t("common.close")}
            >
              ×
            </button>
          </div>
          {file.subtitles.length === 0 && file.videoName && (
            <div className="space-y-2 rounded-2xl border border-yellow-900/30 bg-yellow-950/10 p-3">
              <div className="text-xs text-yellow-600">{t("dashboard.noSubtitleFound")}</div>
              {transcriptionEnabled && file.videoPath && onTranscribe ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onTranscribe(file.videoPath as string, "transcribe_only")}
                      className="rounded-lg bg-gray-800 px-3 py-2 text-xs font-medium text-gray-200 disabled:opacity-50"
                    >
                      {progress?.postAction === "transcribe_only" && isBusy ? t("scan.transcription.working") : t("scan.transcription.transcribe")}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onTranscribe(file.videoPath as string, "transcribe_and_translate")}
                      className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {progress?.postAction === "transcribe_and_translate" && isBusy ? t("scan.transcription.working") : t("scan.transcription.transcribeTranslate")}
                    </button>
                    {canCancel && (
                      <button
                        type="button"
                        onClick={() => onCancelTranscribe?.(file.videoPath as string)}
                        className="rounded-lg border border-red-700/60 bg-red-950/30 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-900/40"
                      >
                        {t("scan.transcription.cancel")}
                      </button>
                    )}
                    {progress && (
                      <div className={`text-[11px] ${stageTone(progress.stage)}`}>
                        {stageText(progress, t)}
                      </div>
                    )}
                  </div>
                  {progress?.stage === "transcribing" && typeof progress.pct === "number" && (
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800" aria-hidden="true">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
                        style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-gray-500">{t("scan.transcription.enableHint")}</div>
              )}
            </div>
          )}
          {file.subtitles.map((sub, j) => (
            <div key={j} className="mt-2 rounded-2xl bg-gray-900/60 p-3">
              <div className="text-xs text-gray-300">{sub.srtName}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {sub.tasks.map((task, k) => {
                  const status = getTaskStatus(task, jobsById);
                  return (
                    <span
                      key={k}
                      className={`rounded-full px-2 py-1 text-[10px] font-medium ${status === "done" ? "bg-green-900/30 text-green-500" : status === "error" ? "bg-red-900/30 text-red-400" : status === "translating" ? "bg-blue-900/30 text-blue-400" : status === "pending" ? "bg-yellow-900/20 text-yellow-500" : "bg-gray-800 text-gray-500"}`}
                    >
                      {task.langCode} {STATUS_ICON[status]}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
