import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useMutationWithInvalidation } from "../../hooks";
import { useToast } from "../../components/Toast";
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

function classifyErrorReason(error: string | null): string {
  if (!error) return "unknown";
  const text = error.toLowerCase();
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  if (text.includes("connection") || text.includes("econnrefused") || text.includes("network")) return "endpoint";
  if (text.includes("rate limit") || text.includes("429")) return "rate-limit";
  if (text.includes("schema") || text.includes("validation")) return "schema";
  if (text.includes("not found") || text.includes("404")) return "not-found";
  return "other";
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
  const { addToast } = useToast();
  const retryMutation = useMutationWithInvalidation((id: number) => api.retryJob(id));
  const forceMutation = useMutationWithInvalidation((id: number) => api.forceJob(id));
  const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;
  const isActive = currentJobId === job.id;
  const hasError = job.status === "error" && job.error;
  const isPending = job.status === "pending";
  const reason = hasError ? classifyErrorReason(job.error) : null;

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
          <ActionButton size="sm" variant="warning" onClick={() => { retryMutation.mutate(job.id); addToast(t("dashboard.toast.jobRetrying"), "info"); }}>{t("dashboard.action.retry")}</ActionButton>
        ) : (job.status === "done" || job.status === "skipped") ? (
          <ActionButton size="sm" variant="ghost" onClick={() => { forceMutation.mutate(job.id); addToast(t("dashboard.toast.retranslating"), "info"); }}>{t("dashboard.action.retranslate")}</ActionButton>
        ) : (
          <button
            type="button"
            onClick={() => onOpenDetails(job)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-center text-[12px] font-medium text-[var(--text)]"
          >{t("dashboard.action.open")}</button>
        )}
      </div>
      {job.status === "error" && (
        <button
          type="button"
          onClick={() => onOpenLogs(job.id)}
          className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-center text-[12px] font-medium text-[var(--text)]"
        >
          {t("dashboard.action.logs")}
        </button>
      )}
    </div>
  );
}
