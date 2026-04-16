import type { Dispatch, SetStateAction } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useMutationWithInvalidation } from "../../hooks";
import { useToast } from "../../components/Toast";
import type { JobRow } from "../../types";
import { ActionButton, ProgressSmall, StatusBadge } from "../../ui/primitives";

interface JobCardMobileProps {
  job: JobRow;
  currentJobId: number | null;
  expandedErrors: Set<number>;
  setExpandedErrors: Dispatch<SetStateAction<Set<number>>>;
  selected: boolean;
  onToggleSelected: (jobId: number) => void;
  onPreview: (jobId: number) => void;
  onOpenLogs: (jobId: number) => void;
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
  expandedErrors,
  setExpandedErrors,
  selected,
  onToggleSelected,
  onPreview,
  onOpenLogs,
}: JobCardMobileProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const retryMutation = useMutationWithInvalidation((id: number) => api.retryJob(id));
  const forceMutation = useMutationWithInvalidation((id: number) => api.forceJob(id));
  const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;
  const isActive = currentJobId === job.id;
  const hasError = job.status === "error" && job.error;
  const expanded = expandedErrors.has(job.id);
  const isPending = job.status === "pending";
  const reason = hasError ? classifyErrorReason(job.error) : null;

  return (
    <div className={`rounded-2xl border p-4 ${isActive ? "border-blue-700/40 bg-blue-900/10" : selected ? "border-blue-700/40 bg-blue-950/20" : "border-gray-800 bg-gray-950/60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {isPending && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelected(job.id)}
              className="mt-1 h-5 w-5 shrink-0 accent-blue-500"
              aria-label={t("dashboard.col.select")}
            />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-gray-200">{job.srt_path.split("/").pop()}</div>
            <div className="mt-1 text-xs text-gray-500">{job.target_lang} • {job.lang_code}</div>
            {reason && <div className="mt-1 inline-flex rounded-full bg-red-900/30 px-2 py-0.5 text-[10px] text-red-200">{t(`dashboard.errorReason.${reason}`)}</div>}
          </div>
        </div>
        <StatusBadge job={job} compact />
      </div>
      {job.status === "translating" && <div className="mt-3"><ProgressSmall pct={pct} /></div>}
      {hasError && (
        <button
          onClick={() => setExpandedErrors((s) => { const n = new Set(s); if (expanded) n.delete(job.id); else n.add(job.id); return n; })}
          className="mt-3 text-left text-xs text-red-400/80"
        >
          {expanded ? t("app.hideError") : t("app.showError")}
        </button>
      )}
      {expanded && <div className="mt-2 rounded-xl bg-red-950/20 p-3 text-xs text-red-300 whitespace-pre-wrap">{job.error}</div>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {(job.status === "done" || job.status === "translating") ? (
          <ActionButton onClick={() => onPreview(job.id)}>{t("dashboard.action.preview")}</ActionButton>
        ) : (
          <NavLink to={`/jobs/${job.id}`} className="rounded-2xl bg-gray-800 px-4 py-3 text-center text-sm font-medium text-gray-200">{t("dashboard.action.details")}</NavLink>
        )}
        {job.status === "error" ? (
          <ActionButton variant="warning" onClick={() => { retryMutation.mutate(job.id); addToast(t("dashboard.toast.jobRetrying"), "info"); }}>{t("dashboard.action.retry")}</ActionButton>
        ) : (job.status === "done" || job.status === "skipped") ? (
          <ActionButton variant="ghost" onClick={() => { forceMutation.mutate(job.id); addToast(t("dashboard.toast.retranslating"), "info"); }}>{t("dashboard.action.retranslate")}</ActionButton>
        ) : (
          <NavLink to={`/jobs/${job.id}`} className="rounded-2xl bg-gray-800 px-4 py-3 text-center text-sm font-medium text-gray-200">{t("dashboard.action.open")}</NavLink>
        )}
      </div>
      {job.status === "error" && (
        <button
          type="button"
          onClick={() => onOpenLogs(job.id)}
          className="mt-2 w-full rounded-2xl border border-gray-700 bg-gray-800 px-4 py-3 text-center text-xs font-medium text-gray-200"
        >
          {t("dashboard.action.logs")}
        </button>
      )}
    </div>
  );
}
