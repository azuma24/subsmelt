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
  onPreview: (jobId: number) => void;
}

export function JobCardMobile({ job, currentJobId, expandedErrors, setExpandedErrors, onPreview }: JobCardMobileProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const retryMutation = useMutationWithInvalidation((id: number) => api.retryJob(id));
  const forceMutation = useMutationWithInvalidation((id: number) => api.forceJob(id));
  const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;
  const isActive = currentJobId === job.id;
  const hasError = job.status === "error" && job.error;
  const expanded = expandedErrors.has(job.id);

  return (
    <div className={`rounded-2xl border p-4 ${isActive ? "border-blue-700/40 bg-blue-900/10" : "border-gray-800 bg-gray-950/60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-gray-200">{job.srt_path.split("/").pop()}</div>
          <div className="mt-1 text-xs text-gray-500">{job.target_lang} • {job.lang_code}</div>
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
    </div>
  );
}
