import { useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { JobRow, ScannedFile } from "../../types";
import { STATUS_ICON } from "../../app/constants";
import { isManualTranscriptionBusy, type ManualTranscriptionProgress, type TranscribePostAction } from "./transcription-progress";
import { getPendingJobIds, getTaskStatus, stageText, stageTone } from "./scan-file-status";

interface CompactScanFileRowProps {
  file: ScannedFile;
  padLeftPx: number;
  /** When set (search mode), the row is labelled by relative path, not name. */
  relPath?: string;
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
}

export function CompactScanFileRow({
  file,
  padLeftPx,
  relPath,
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
}: CompactScanFileRowProps) {
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
      <div
        className={`flex w-full items-center justify-between gap-3 py-3 pr-4 text-left hover:bg-[var(--surface-2)] ${allPendingSelected || somePendingSelected ? "bg-[var(--accent-dim)]" : ""}`}
        style={{ paddingLeft: `${padLeftPx}px` }}
      >
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
              <span className="truncate font-medium">{relPath ?? (file.videoName || t("dashboard.orphanSubtitle"))}</span>
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
