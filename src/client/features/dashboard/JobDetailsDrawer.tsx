import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { JobRow } from "../../types";
import { Drawer, StatusBadge } from "../../ui/primitives";
import { formatDur, formatTokens, formatCost } from "../../lib";

interface JobDetailsDrawerProps {
  job: JobRow | null;
  open: boolean;
  onClose: () => void;
  onOpenLogs: (jobId: number) => void;
}

export function JobDetailsDrawer({ job, open, onClose, onOpenLogs }: JobDetailsDrawerProps) {
  const { t } = useTranslation();

  if (!job) return null;

  const srtName = job.srt_path.split("/").pop() || job.srt_path;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t("dashboard.details.title")}
      width="max-w-lg"
    >
      <div className="space-y-4">
        {/* File */}
        <section>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
            {t("dashboard.details.path")}
          </div>
          <div className="text-[13px] font-medium text-[var(--text)]">{srtName}</div>
          <div
            className="mt-1 select-all break-all font-mono text-[11px] text-[var(--text-2)]"
            title={job.srt_path}
          >
            {job.srt_path}
          </div>
        </section>

        {/* Output path */}
        <section>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
            {t("dashboard.details.output")}
          </div>
          <div className="select-all break-all font-mono text-[11px] text-[var(--text-2)]">
            {job.output_path}
          </div>
        </section>

        {/* Target language */}
        <section>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
            {t("dashboard.details.target")}
          </div>
          <div className="text-[13px] text-[var(--text)]">
            {job.target_lang}
            {job.lang_code && (
              <span className="ml-2 font-mono text-[11px] text-[var(--text-3)]">({job.lang_code})</span>
            )}
          </div>
        </section>

        {/* Status + Duration + Cues */}
        <div className="grid grid-cols-2 gap-3">
          <section>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              {t("dashboard.details.status")}
            </div>
            <StatusBadge job={job} />
          </section>
          <section>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              {t("dashboard.details.duration")}
            </div>
            <div className="font-mono text-[13px] text-[var(--text)]">
              {job.duration_seconds ? formatDur(job.duration_seconds) : "—"}
            </div>
          </section>
        </div>

        {/* Cues */}
        <section>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
            {t("dashboard.details.cues")}
          </div>
          <div className="font-mono text-[13px] text-[var(--text)]">
            {job.total_cues > 0
              ? `${job.completed_cues} / ${job.total_cues}`
              : "—"}
          </div>
        </section>

        {/* Tokens + estimated cost */}
        <div className="grid grid-cols-2 gap-3">
          <section>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              {t("dashboard.details.tokens")}
            </div>
            <div className="font-mono text-[13px] text-[var(--text)]">
              {(job.input_tokens || job.output_tokens)
                ? `${formatTokens(job.input_tokens)} / ${formatTokens(job.output_tokens)}`
                : "—"}
            </div>
          </section>
          <section>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              {t("dashboard.details.cost")}
            </div>
            <div className="font-mono text-[13px] text-[var(--text)]">
              {job.est_cost === null || job.est_cost === undefined
                ? <span className="italic text-[var(--text-3)]">{t("dashboard.details.costLocal")}</span>
                : (
                  <span title={t("dashboard.details.costApprox")}>
                    ≈ {formatCost(job.est_cost)}
                  </span>
                )}
            </div>
          </section>
        </div>

        {/* Translated by */}
        <section>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
            {t("dashboard.details.translatedBy")}
          </div>
          <div className="text-[13px] text-[var(--text)]">
            {job.used_connections
              ? job.used_connections
              : <span className="italic text-[var(--text-3)]">{t("dashboard.details.notRecorded")}</span>}
          </div>
        </section>

        {/* Job ID */}
        <section>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
            {t("dashboard.details.jobId")}
          </div>
          <div className="font-mono text-[13px] text-[var(--text)]">#{job.id}</div>
        </section>

        {/* Error */}
        {job.error && (
          <section>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              {t("dashboard.details.error")}
            </div>
            <div className="select-all whitespace-pre-wrap rounded-lg bg-[var(--red-dim)] p-3 font-mono text-[11px] text-[var(--red)]">
              {job.error}
            </div>
          </section>
        )}

        {/* Analysis context */}
        {job.analysis_context && (
          <section>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              {t("dashboard.details.analysis")}
            </div>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[11px] text-[var(--text-2)]">
              {job.analysis_context}
            </div>
          </section>
        )}

        {/* Footer actions */}
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={() => { onOpenLogs(job.id); onClose(); }}
            className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--surface-3)]"
          >
            {t("dashboard.details.openLogs")}
          </button>
          <NavLink
            to={`/jobs/${job.id}`}
            onClick={onClose}
            className="flex-1 rounded-lg border border-[var(--accent-border)] bg-[var(--accent-dim)] px-3 py-2 text-center text-[13px] font-medium text-[var(--accent)] hover:brightness-110"
          >
            {t("dashboard.details.fullPage")}
          </NavLink>
        </div>
      </div>
    </Drawer>
  );
}
