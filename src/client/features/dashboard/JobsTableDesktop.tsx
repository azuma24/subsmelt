import { Fragment, type Dispatch, type SetStateAction } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { formatDur } from "../../lib";
import { useMutationWithInvalidation } from "../../hooks";
import { useToast } from "../../components/Toast";
import type { JobRow } from "../../types";
import { MiniBtn, ProgressSmall, StatusBadge } from "../../ui/primitives";

interface JobsTableDesktopProps {
  jobs: JobRow[];
  currentJobId: number | null;
  expandedErrors: Set<number>;
  setExpandedErrors: Dispatch<SetStateAction<Set<number>>>;
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
  onPreview: (jobId: number) => void;
}

export function JobsTableDesktop({
  jobs,
  currentJobId,
  expandedErrors,
  setExpandedErrors,
  selectedIds,
  setSelectedIds,
  onPreview,
}: JobsTableDesktopProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const retryMutation = useMutationWithInvalidation((id: number) => api.retryJob(id));
  const forceMutation = useMutationWithInvalidation((id: number) => api.forceJob(id));
  const pinMutation = useMutationWithInvalidation((id: number) => api.pinJob(id));
  const deleteMutation = useMutationWithInvalidation((id: number) => api.deleteJobApi(id));

  const pendingIds = jobs.filter((j) => j.status === "pending").map((j) => j.id);
  const visiblePendingSelectedCount = pendingIds.filter((id) => selectedIds.has(id)).length;
  const allPendingSelected = pendingIds.length > 0 && visiblePendingSelectedCount === pendingIds.length;
  const somePendingSelected = visiblePendingSelectedCount > 0 && !allPendingSelected;

  const toggleOne = (id: number) => {
    setSelectedIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((s) => {
      const n = new Set(s);
      if (allPendingSelected) {
        pendingIds.forEach((id) => n.delete(id));
      } else {
        pendingIds.forEach((id) => n.add(id));
      }
      return n;
    });
  };

  const handleDelete = (id: number) => {
    deleteMutation.mutate(id);
    setSelectedIds((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-800/30 text-gray-500 text-xs">
          <tr>
            <th className="px-3 py-3 w-8">
              <input
                type="checkbox"
                className="accent-blue-500"
                disabled={pendingIds.length === 0}
                checked={allPendingSelected}
                ref={(el) => {
                  if (el) el.indeterminate = somePendingSelected;
                }}
                onChange={toggleAllVisible}
                aria-label={t("dashboard.col.selectAll")}
              />
            </th>
            <th className="px-4 py-3 text-left font-medium">{t("dashboard.col.file")}</th>
            <th className="px-4 py-3 text-left font-medium">{t("dashboard.col.target")}</th>
            <th className="px-4 py-3 text-left font-medium">{t("dashboard.col.status")}</th>
            <th className="px-4 py-3 text-left font-medium">{t("dashboard.col.progress")}</th>
            <th className="px-4 py-3 text-left font-medium">{t("dashboard.col.time")}</th>
            <th className="px-4 py-3 text-left font-medium">{t("dashboard.col.actions")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/30">
          {jobs.length === 0 && (
            <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-600 text-xs">{t("dashboard.noJobsMatchFilter")}</td></tr>
          )}
          {jobs.map((job) => {
            const srtName = job.srt_path.split("/").pop() || "";
            const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;
            const isActive = job.id === currentJobId;
            const hasError = job.status === "error" && job.error;
            const isErrorExpanded = expandedErrors.has(job.id);
            const isPending = job.status === "pending";
            const isSelected = selectedIds.has(job.id);
            return (
              <Fragment key={job.id}>
                <tr className={isActive ? "bg-blue-900/5" : isSelected ? "bg-blue-900/10" : "hover:bg-gray-800/30"}>
                  <td className="px-3 py-3 w-8">
                    {isPending && (
                      <input
                        type="checkbox"
                        className="accent-blue-500"
                        checked={isSelected}
                        onChange={() => toggleOne(job.id)}
                        aria-label={t("dashboard.col.select")}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-300 max-w-[240px] truncate" title={job.srt_path}>{srtName}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{job.target_lang}<br /><span className="text-gray-600">{job.lang_code}</span></td>
                  <td className="px-4 py-3">
                    <StatusBadge job={job} />
                    {hasError && (
                      <button
                        onClick={() => setExpandedErrors((s) => { const n = new Set(s); if (isErrorExpanded) n.delete(job.id); else n.add(job.id); return n; })}
                        className="block mt-1 text-[11px] text-red-400/70 hover:text-red-400 truncate max-w-[220px] text-left"
                      >
                        {isErrorExpanded ? "▼" : "▶"} {job.error}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 w-40">{job.status === "translating" ? <ProgressSmall pct={pct} /> : job.status === "done" ? <span className="text-[10px] text-gray-600">{t("dashboard.cues", { completed: job.completed_cues, total: job.total_cues })}</span> : null}</td>
                  <td className="px-4 py-3 text-[10px] text-gray-600">{job.duration_seconds ? formatDur(job.duration_seconds) : ""}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {isPending && <MiniBtn onClick={() => pinMutation.mutate(job.id)}>{t("dashboard.action.pin")}</MiniBtn>}
                      {(job.status === "done" || job.status === "translating") && <MiniBtn onClick={() => onPreview(job.id)}>{t("dashboard.action.preview")}</MiniBtn>}
                      {job.status === "error" && <MiniBtn color="yellow" onClick={() => { retryMutation.mutate(job.id); addToast(t("dashboard.toast.jobRetrying"), "info"); }}>{t("dashboard.action.retry")}</MiniBtn>}
                      {(job.status === "done" || job.status === "skipped") && <MiniBtn onClick={() => { forceMutation.mutate(job.id); addToast(t("dashboard.toast.retranslating"), "info"); }}>{t("dashboard.action.retranslate")}</MiniBtn>}
                      <NavLink to={`/jobs/${job.id}`} className="rounded-lg bg-gray-800 px-2 py-1 text-[11px] text-gray-300">{t("dashboard.action.details")}</NavLink>
                      <button
                        onClick={() => handleDelete(job.id)}
                        className="text-gray-600 hover:text-red-400 text-xs px-1"
                        aria-label={t("dashboard.action.delete")}
                      >×</button>
                    </div>
                  </td>
                </tr>
                {hasError && isErrorExpanded && (
                  <tr><td colSpan={7} className="px-4 py-3 bg-red-950/20 text-xs text-red-300 font-mono whitespace-pre-wrap">{job.error}</td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
