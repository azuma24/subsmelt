import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { JobRow, ManualTranscriptionStage, ScannedFile, TaskStatus } from "../../types";
import { STATUS_ICON } from "../../app/constants";
import { isManualTranscriptionBusy, type ManualTranscriptionProgress, type TranscribePostAction } from "./transcription-progress";
import { scanFileKey, sortScanFiles, sortScanGroups, type DashboardSortBy, type DashboardSortDir } from "./scanSort";

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
  sortBy: DashboardSortBy;
  sortDir: DashboardSortDir;
  onSortByChange: (value: DashboardSortBy) => void;
  onToggleSortDir: () => void;
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
      return "text-[var(--green)]";
    case "skipped":
      return "text-[var(--yellow)]";
    case "failed":
      return "text-[var(--red)]";
    case "cancelled":
      return "text-[var(--text-2)]";
    case "cancelling":
      return "text-[var(--yellow)]";
    default:
      return "text-[var(--accent)]";
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
  sortBy,
  sortDir,
  onSortByChange,
  onToggleSortDir,
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
    return sortScanGroups(
      Array.from(grouped.entries()).map(([name, groupFiles]) => [name, sortScanFiles(groupFiles, sortBy, sortDir)]),
      sortBy,
      sortDir,
    );
  }, [filteredFiles, mediaDir, sortBy, sortDir]);
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
    <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--text-2)]">{t("dashboard.library")}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${mode === "preview" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "bg-[var(--green-dim)] text-[var(--green)]"}`}>
              {mode === "preview" ? t("app.scanPreviewBadge") : t("app.scanQueuedBadge")}
            </span>
          </div>
          <p className="text-xs text-[var(--text-3)]">{mode === "preview" ? t("app.scanPreviewHint") : t("app.scanGroupedHint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--text-3)]">{t("dashboard.entries", { count: filteredFiles.length })}</span>
          {batchEnabled && visibleSelectedPaths.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onBatchTranscribe?.(visibleSelectedPaths, "transcribe_only")}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-3)]"
              >
                {t("scan.transcription.batchTranscribe", { count: visibleSelectedPaths.length })}
              </button>
              <button
                type="button"
                onClick={() => onBatchTranscribe?.(visibleSelectedPaths, "transcribe_and_translate")}
                className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--on-accent)] hover:brightness-110"
              >
                {t("scan.transcription.batchTranscribeTranslate", { count: visibleSelectedPaths.length })}
              </button>
              <button
                type="button"
                onClick={() => setSelectedVideoPaths?.(new Set())}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)]"
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
              className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--on-accent)] hover:brightness-110 disabled:opacity-40"
            >
              {isQueueing ? t("dashboard.scanning") : t("dashboard.queuePreview", { count: newJobsCount })}
            </button>
          )}
        </div>
      </div>
      <div className="border-b border-[var(--border)] px-4 py-3 space-y-3">
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
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${filter === chip.key ? "bg-[var(--accent-dim)] text-[var(--accent)] border border-[var(--accent-border)]" : "bg-[var(--surface-2)] text-[var(--text-2)]"}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("app.scanSearchPlaceholder")}
          className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-sm text-[var(--text)]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="dashboard-scan-sort" className="text-xs text-[var(--text-3)]">{t("whisper.sortAriaLabel")}</label>
          <select
            id="dashboard-scan-sort"
            value={sortBy}
            onChange={(event) => onSortByChange(event.target.value as DashboardSortBy)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--text)]"
          >
            <option value="name">{t("whisper.sortByName")}</option>
            <option value="date">{t("whisper.sortByDate")}</option>
          </select>
          <button
            type="button"
            onClick={onToggleSortDir}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--text)]"
            aria-label={sortDir === "asc" ? t("whisper.sortAsc") : t("whisper.sortDesc")}
            title={sortDir === "asc" ? t("whisper.sortAsc") : t("whisper.sortDesc")}
          >
            {sortDir === "asc" ? "↑" : "↓"}
          </button>
        </div>
      </div>
      <div className="max-h-[50vh] overflow-y-auto">
        {groups.length === 0 && <div className="px-4 py-6 text-center text-[var(--text-3)] text-sm"><div>{t("app.scanNoMatch")}</div><div className="mt-1 text-xs text-[var(--text-3)]">{t("dashboard.emptyScanHint")}</div></div>}
        <div className="divide-y divide-[var(--border-sub)]">
          {groups.map(([group, groupFiles]) => {
            const expanded = expandedGroups.has(group);
            return (
              <div key={group}>
                <button onClick={() => toggleGroup(group)} className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--surface-2)]">
                  <div>
                    <div className="text-sm font-medium text-[var(--text)]">{group}</div>
                    <div className="text-[11px] text-[var(--text-3)]">{t("app.scanItems", { count: groupFiles.length })}</div>
                  </div>
                  <div className="text-xs text-[var(--text-3)]">{expanded ? t("app.scanHide") : t("app.scanShow")}</div>
                </button>
                {expanded && (
                  <div className="border-t border-[var(--border)] bg-[var(--surface-2)]">
                    {groupFiles.map((file) => (
                      <CompactScanFileRow
                        key={scanFileKey(file)}
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
    <div className="border-b border-[var(--border-sub)] last:border-b-0">
      <div className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[var(--surface-2)] ${allPendingSelected || somePendingSelected ? "bg-[var(--accent-dim)]" : ""}`}>
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
            className="h-4 w-4 shrink-0 accent-[var(--green)]"
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
            className="h-4 w-4 shrink-0 accent-[var(--accent)]"
            aria-label={t("app.scanSelectPending")}
          />
        )}
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-[var(--text)]">
              <span className="text-[var(--text-3)]">{file.videoName ? "🎬" : "📝"}</span>
              <span className="truncate font-medium">{file.videoName || t("dashboard.orphanSubtitle")}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-[var(--text-3)]">
              {hasNew && <span className="rounded-full bg-[var(--accent-dim)] px-2 py-0.5 text-[var(--accent)]">{t("app.scanNewJobs")}</span>}
              {pendingJobIds.length > 0 && <span className="rounded-full bg-[var(--yellow-dim)] px-2 py-0.5 text-[var(--yellow)]">{t("app.scanPendingJobs", { count: pendingJobIds.length })}</span>}
              {missing && <span className="rounded-full bg-[var(--yellow-dim)] px-2 py-0.5 text-[var(--yellow)]">{t("app.scanMissingSubtitles")}</span>}
              {orphan && <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[var(--text-2)]">{t("app.scanOrphan")}</span>}
              <span>{t("app.subtitleCount", { count: file.subtitles.length })}</span>
              {progress && <span className={stageTone(progress.stage)}>{stageText(progress, t)}</span>}
            </div>
          </div>
        </button>
        <button type="button" onClick={() => setOpen(!open)} className="text-xs text-[var(--text-3)]">{open ? t("app.scanHide") : t("app.scanDetails")}</button>
      </div>
      {open && (
        <div className="px-4 pb-4">
          <div className="mb-2 flex items-center justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-2)] hover:text-[var(--text)]"
              aria-label={t("common.close")}
              title={t("common.close")}
            >
              ×
            </button>
          </div>
          {file.subtitles.length === 0 && file.videoName && (
            <div className="space-y-2 rounded-2xl border border-[var(--yellow-border)] bg-[var(--yellow-dim)] p-3">
              <div className="text-xs text-[var(--yellow)]">{t("dashboard.noSubtitleFound")}</div>
              {transcriptionEnabled && file.videoPath && onTranscribe ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onTranscribe(file.videoPath as string, "transcribe_only")}
                      className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)] disabled:opacity-50"
                    >
                      {progress?.postAction === "transcribe_only" && isBusy ? t("scan.transcription.working") : t("scan.transcription.transcribe")}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onTranscribe(file.videoPath as string, "transcribe_and_translate")}
                      className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--on-accent)] hover:brightness-110 disabled:opacity-50"
                    >
                      {progress?.postAction === "transcribe_and_translate" && isBusy ? t("scan.transcription.working") : t("scan.transcription.transcribeTranslate")}
                    </button>
                    {canCancel && (
                      <button
                        type="button"
                        onClick={() => onCancelTranscribe?.(file.videoPath as string)}
                        className="rounded-lg border border-[var(--red-border)] bg-[var(--red-dim)] px-3 py-2 text-xs font-medium text-[var(--red)] hover:bg-[var(--red-dim)]"
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
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]" aria-hidden="true">
                      <div
                        className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                        style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-[var(--text-3)]">{t("scan.transcription.enableHint")}</div>
              )}
            </div>
          )}
          {file.subtitles.map((sub, j) => (
            <div key={j} className="mt-2 rounded-2xl bg-[var(--surface)] p-3">
              <div className="text-xs text-[var(--text-2)]">{sub.srtName}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {sub.tasks.map((task, k) => {
                  const status = getTaskStatus(task, jobsById);
                  return (
                    <span
                      key={k}
                      className={`rounded-full px-2 py-1 text-[10px] font-medium ${status === "done" ? "bg-[var(--green-dim)] text-[var(--green)]" : status === "error" ? "bg-[var(--red-dim)] text-[var(--red)]" : status === "translating" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : status === "pending" ? "bg-[var(--yellow-dim)] text-[var(--yellow)]" : "bg-[var(--surface-2)] text-[var(--text-3)]"}`}
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
