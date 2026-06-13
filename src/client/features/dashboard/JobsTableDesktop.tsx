import { Fragment, type Dispatch, type SetStateAction } from "react";
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
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
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

const TH = "px-[10px] py-[7px] text-left text-[10.5px] font-semibold uppercase tracking-[0.4px] text-[var(--text-3)] border-b border-[var(--border)]";
const TD = "px-[10px] py-[9px] align-middle border-b border-[var(--border-sub)]";

export function JobsTableDesktop({
  jobs,
  currentJobId,
  selectedIds,
  setSelectedIds,
  onPreview,
  onOpenLogs,
  onOpenDetails,
}: JobsTableDesktopProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const retryMutation = useMutationWithInvalidation((id: number) => api.retryJob(id));
  const forceMutation = useMutationWithInvalidation((id: number) => api.forceJob(id));
  const pinMutation = useMutationWithInvalidation((id: number) => api.pinJob(id));
  const unpinMutation = useMutationWithInvalidation((id: number) => api.unpinJob(id));
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
      <table className="w-full min-w-[820px] border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={`${TH} w-8`}>
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                disabled={pendingIds.length === 0}
                checked={allPendingSelected}
                ref={(el) => {
                  if (el) el.indeterminate = somePendingSelected;
                }}
                onChange={toggleAllVisible}
                aria-label={t("dashboard.col.selectAll")}
              />
            </th>
            <th className={TH}>{t("dashboard.col.file")}</th>
            <th className={TH}>{t("dashboard.col.target")}</th>
            <th className={TH}>{t("dashboard.col.status")}</th>
            <th className={TH}>{t("dashboard.col.progress")}</th>
            <th className={TH}>{t("dashboard.col.time")}</th>
            <th className={TH}>{t("dashboard.col.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 && (
            <tr><td colSpan={7} className="px-4 py-8 text-center text-[12px] text-[var(--text-3)]">{t("dashboard.noJobsMatchFilter")}</td></tr>
          )}
          {jobs.map((job) => {
            const srtName = job.srt_path.split("/").pop() || "";
            const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;
            const isActive = job.id === currentJobId;
            const hasError = job.status === "error" && job.error;
            const isPending = job.status === "pending";
            const isSelected = selectedIds.has(job.id);
            const reason = hasError ? classifyErrorReason(job.error) : null;
            return (
              <Fragment key={job.id}>
                <tr className={`group ${isActive ? "bg-[var(--accent-dim)]" : isSelected ? "bg-[var(--accent-dim)]" : "hover:bg-[var(--surface-2)]"}`}>
                  <td className={`${TD} w-8`}>
                    {isPending && (
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)]"
                        checked={isSelected}
                        onChange={() => toggleOne(job.id)}
                        aria-label={t("dashboard.col.select")}
                      />
                    )}
                  </td>
                  <td className={`${TD} max-w-[280px]`}>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 text-[13px] opacity-50">📄</span>
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-[var(--text)]" title={job.srt_path}>{srtName}</div>
                      </div>
                    </div>
                  </td>
                  <td className={`${TD} text-[12px] text-[var(--text-2)]`}>{job.target_lang}<br /><span className="text-[var(--text-3)]">{job.lang_code}</span></td>
                  <td className={TD}>
                    <StatusBadge job={job} />
                    {reason && (
                      <span className="ml-2 rounded-full bg-[var(--red-dim)] px-2 py-0.5 text-[10px] text-[var(--red)]">{t(`dashboard.errorReason.${reason}`)}</span>
                    )}
                  </td>
                  <td className={`${TD} w-40`}>{job.status === "translating" ? <ProgressSmall pct={pct} /> : job.status === "done" ? <span className="text-[10px] text-[var(--text-3)]">{t("dashboard.cues", { completed: job.completed_cues, total: job.total_cues })}</span> : null}</td>
                  <td className={`${TD} font-mono text-[11.5px] text-[var(--text-2)]`}>{job.duration_seconds ? formatDur(job.duration_seconds) : ""}</td>
                  <td className={TD}>
                    <div className="flex flex-wrap gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                      {isPending && job.priority > 0 && (
                        <MiniBtn onClick={() => unpinMutation.mutate(job.id)}>{t("dashboard.action.unpin")}</MiniBtn>
                      )}
                      {isPending && job.priority <= 0 && (
                        <MiniBtn onClick={() => pinMutation.mutate(job.id)}>{t("dashboard.action.pin")}</MiniBtn>
                      )}
                      {(job.status === "done" || job.status === "translating") && <MiniBtn onClick={() => onPreview(job.id)}>{t("dashboard.action.preview")}</MiniBtn>}
                      {job.status === "error" && <MiniBtn color="yellow" onClick={() => { retryMutation.mutate(job.id); addToast(t("dashboard.toast.jobRetrying"), "info"); }}>{t("dashboard.action.retry")}</MiniBtn>}
                      {(job.status === "done" || job.status === "skipped") && <MiniBtn onClick={() => { forceMutation.mutate(job.id); addToast(t("dashboard.toast.retranslating"), "info"); }}>{t("dashboard.action.retranslate")}</MiniBtn>}
                      {job.status === "error" && <MiniBtn onClick={() => onOpenLogs(job.id)}>{t("dashboard.action.logs")}</MiniBtn>}
                      <button
                        onClick={() => onOpenDetails(job)}
                        className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--text-2)] hover:text-[var(--text)]"
                      >{t("dashboard.action.details")}</button>
                      <button
                        onClick={() => handleDelete(job.id)}
                        className="rounded-md px-1.5 text-[var(--text-3)] hover:text-[var(--red)]"
                        aria-label={t("dashboard.action.delete")}
                      >×</button>
                    </div>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
