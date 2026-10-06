import { memo } from "react";
import { useTranslation } from "react-i18next";
import { useJobActions } from "../../hooks/useJobActions";
import type { Job } from "../../types";
import { ActionButton, ProgressSmall, RowActionsMenu } from "../../ui/primitives";
import { JobStatusBadge } from "../jobs/JobStatusBadge";
import { jobDerived } from "./job-derived";

interface JobCardMobileProps {
  job: Job;
  currentJobId: number | null;
  selected: boolean;
  onToggleSelected: (jobId: number) => void;
  onPreview: (jobId: number) => void;
  onOpenLogs: (jobId: number) => void;
  onOpenDetails: (job: Job) => void;
}

const SKELETON_CARDS = 3;

/** Placeholder cards in the real card layout while the first jobs request is in flight. */
export function JobCardSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2" role="status" aria-busy="true" aria-label={t("errors.loading")}>
      <span className="sr-only">{t("errors.loading")}</span>
      {Array.from({ length: SKELETON_CARDS }, (_, i) => (
        <div key={i} className="rounded-md border border-border bg-surface p-3" aria-hidden="true">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-3/4 rounded-sm bg-surface-highlight" />
              <div className="h-3 w-1/2 rounded-sm bg-surface-raised" />
            </div>
            <div className="h-6 w-16 rounded-full bg-surface-raised" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One mobile card. Memoized so a progress tick re-renders only the translating
 * card — the optimistic jobs patch replaces just that job's object, and the
 * handlers hold stable identities.
 */
export const JobCardMobile = memo(function JobCardMobile({
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
  const { srtName, pct, hasError, isPending, isSkipped, reason, connectionText, connectionTitle } = jobDerived(job);
  const isActive = currentJobId === job.id;

  return (
    <div className={`rounded-md border p-3 ${isActive ? "border-accent-line bg-accent-soft" : hasError ? "border-danger-line bg-surface" : selected ? "border-accent-line bg-accent-soft" : "border-border bg-surface"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {isPending && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelected(job.id)}
              className="mt-1 h-5 w-5 shrink-0 accent-accent"
              aria-label={t("dashboard.col.select")}
            />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-text">{srtName}</div>
            <div className="mt-1 text-xs text-muted">{job.target_lang} · {job.lang_code}</div>
            {reason && <div className="mt-1 inline-flex rounded-full bg-danger-soft px-2 py-1 text-xs text-danger">{t(`dashboard.errorReason.${reason}`)}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <JobStatusBadge job={job} />
          {/* Secondary actions (pin, logs, delete) collapse into one menu — the
              old stacked full-width buttons made every card ~3 rows taller. */}
          <RowActionsMenu
            items={[
              ...(isPending
                ? [job.priority > 0
                    ? { label: t("dashboard.action.unpin"), onClick: () => jobActions.unpin(job.id), disabled: jobActions.isUnpinning }
                    : { label: t("dashboard.action.pin"), onClick: () => jobActions.pin(job.id), disabled: jobActions.isPinning }]
                : []),
              ...(job.status === "error"
                ? [{ label: t("dashboard.action.logs"), onClick: () => onOpenLogs(job.id) }]
                : []),
              { label: t("dashboard.action.details"), onClick: () => onOpenDetails(job) },
              { label: t("dashboard.action.delete"), onClick: () => { void jobActions.remove(job.id); }, danger: true, disabled: jobActions.isDeleting },
            ]}
          />
        </div>
      </div>
      {job.status === "translating" && (
        <div className="mt-3">
          <ProgressSmall pct={pct} />
          {job.connection && (
            <div className="mt-1 truncate text-xs text-faint" title={connectionTitle ?? undefined}>
              {connectionText}
            </div>
          )}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {(job.status === "done" || job.status === "translating") ? (
          <ActionButton size="sm" onClick={() => onPreview(job.id)}>{t("dashboard.action.preview")}</ActionButton>
        ) : (
          <button
            type="button"
            onClick={() => onOpenDetails(job)}
            className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-center text-xs font-medium text-text"
          >{t("dashboard.action.details")}</button>
        )}
        {job.status === "error" ? (
          <ActionButton size="sm" variant="warning" busy={jobActions.isRetrying} onClick={() => jobActions.retry(job.id)}>{t("dashboard.action.retry")}</ActionButton>
        ) : job.status === "translating" ? (
          // Cancelling one translating job aborts its LLM work and ends it as a
          // cancelled error; the queue keeps running with the next pending job.
          <ActionButton size="sm" variant="danger" busy={jobActions.isCancelling} onClick={() => jobActions.cancel(job.id)}>{t("dashboard.action.cancel")}</ActionButton>
        ) : job.status === "skipped" ? (
          // Never translated (an existing target subtitle was found), so this is
          // an opt-in "do it anyway", not a re-run of previous work.
          <ActionButton size="sm" variant="warning" busy={jobActions.isRetranslating} onClick={() => jobActions.retranslate(job.id)}>{t("dashboard.action.translateAnyway")}</ActionButton>
        ) : job.status === "done" ? (
          <ActionButton size="sm" variant="ghost" busy={jobActions.isRetranslating} onClick={() => jobActions.retranslate(job.id)}>{t("dashboard.action.retranslate")}</ActionButton>
        ) : (
          <button
            type="button"
            onClick={() => onOpenDetails(job)}
            className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-center text-xs font-medium text-text"
          >{t("dashboard.action.open")}</button>
        )}
      </div>
    </div>
  );
});
