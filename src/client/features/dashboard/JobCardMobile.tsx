import { useTranslation } from "react-i18next";
import { useJobActions } from "../../hooks/useJobActions";
import type { JobRow } from "../../types";
import { ActionButton, ProgressSmall, StatusBadge } from "../../ui/primitives";

interface JobCardMobileProps {
  job: JobRow;
  currentJobId: number | null;
  selected: boolean;
  onToggleSelected: (jobId: number) => void;
  onPreview: (jobId: number) => void;
  onOpenLogs: (jobId: number) => void;
  onOpenDetails: (job: JobRow) => void;
}

export function JobCardMobile({
  job,
  currentJobId,
  selected,
  onToggleSelected,
  onPreview,
  onOpenLogs,
  onOpenDetails,
}: JobCardMobileProps) {
  const { t } = useTranslation();
  const jobActions = useJobActions();
  const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;
  const isActive = currentJobId === job.id;
  const hasError = job.status === "error" && job.error;
  const isPending = job.status === "pending";
  const reason = hasError ? jobActions.classifyErrorReason(job.error) : null;

  return (
    <div className={`rounded-xl border p-[11px] ${isActive ? "border-[var(--accent-border)] bg-[var(--accent-dim)]" : hasError ? "border-[var(--red-border)] bg-[var(--surface)]" : selected ? "border-[var(--accent-border)] bg-[var(--accent-dim)]" : "border-[var(--border)] bg-[var(--surface)]"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {isPending && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelected(job.id)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
              aria-label={t("dashboard.col.select")}
            />
          )}
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[var(--text)]">{job.srt_path.split("/").pop()}</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-2)]">{job.target_lang} · {job.lang_code}</div>
            {reason && <div className="mt-1 inline-flex rounded-full bg-[var(--red-dim)] px-2 py-0.5 text-[10px] text-[var(--red)]">{t(`dashboard.errorReason.${reason}`)}</div>}
          </div>
        </div>
        <StatusBadge job={job} compact />
      </div>
      {job.status === "translating" && <div className="mt-3"><ProgressSmall pct={pct} /></div>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {(job.status === "done" || job.status === "translating") ? (
          <ActionButton size="sm" onClick={() => onPreview(job.id)}>{t("dashboard.action.preview")}</ActionButton>
        ) : (
          <button
            type="button"
            onClick={() => onOpenDetails(job)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-center text-[12px] font-medium text-[var(--text)]"
          >{t("dashboard.action.details")}</button>
        )}
        {job.status === "error" ? (
          <ActionButton size="sm" variant="warning" busy={jobActions.isRetrying} onClick={() => jobActions.retry(job.id)}>{t("dashboard.action.retry")}</ActionButton>
        ) : (job.status === "done" || job.status === "skipped") ? (
          <ActionButton size="sm" variant="ghost" busy={jobActions.isRetranslating} onClick={() => jobActions.retranslate(job.id)}>{t("dashboard.action.retranslate")}</ActionButton>
        ) : (
          <button
            type="button"
            onClick={() => onOpenDetails(job)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-center text-[12px] font-medium text-[var(--text)]"
          >{t("dashboard.action.open")}</button>
        )}
      </div>
      {isPending && (
        <div className="mt-2">
          {job.priority > 0 ? (
            <ActionButton size="sm" variant="ghost" className="w-full" busy={jobActions.isUnpinning} onClick={() => jobActions.unpin(job.id)}>{t("dashboard.action.unpin")}</ActionButton>
          ) : (
            <ActionButton size="sm" variant="ghost" className="w-full" busy={jobActions.isPinning} onClick={() => jobActions.pin(job.id)}>{t("dashboard.action.pin")}</ActionButton>
          )}
        </div>
      )}
      {job.status === "error" && (
        <button
          type="button"
          onClick={() => onOpenLogs(job.id)}
          className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-center text-[12px] font-medium text-[var(--text)]"
        >
          {t("dashboard.action.logs")}
        </button>
      )}
      <button
        type="button"
        onClick={() => { void jobActions.remove(job.id); }}
        disabled={jobActions.isDeleting}
        className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-center text-[12px] font-medium text-[var(--text-3)] hover:text-[var(--red)] disabled:opacity-40"
      >
        {t("dashboard.action.delete")}
      </button>
    </div>
  );
}
