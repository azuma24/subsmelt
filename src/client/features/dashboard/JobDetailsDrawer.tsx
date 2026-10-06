import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { classifyError, errorHintKeys } from "../../lib/errorTaxonomy";
import type { Job } from "../../types";
import { Drawer } from "../../ui/primitives";
import { JobStatusBadge } from "../jobs/JobStatusBadge";
import { formatDur, formatTokens, formatCost } from "../../lib";

interface JobDetailsDrawerProps {
  job: Job | null;
  open: boolean;
  onClose: () => void;
  onOpenLogs: (jobId: number) => void;
}

export function JobDetailsDrawer({ job, open, onClose, onOpenLogs }: JobDetailsDrawerProps) {
  const { t } = useTranslation();
  // Queue jobs fail against the LLM connection, not the Whisper backend.
  const errorHint = errorHintKeys(classifyError(job?.error ?? null), "translation");

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
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
            {t("dashboard.details.path")}
          </div>
          <div className="text-sm font-medium text-text">{srtName}</div>
          <div
            className="mt-1 select-all break-all font-mono text-xs text-muted"
            title={job.srt_path}
          >
            {job.srt_path}
          </div>
        </section>

        {/* Output path */}
        <section>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
            {t("dashboard.details.output")}
          </div>
          <div className="select-all break-all font-mono text-xs text-muted">
            {job.output_path}
          </div>
        </section>

        {/* Target language */}
        <section>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
            {t("dashboard.details.target")}
          </div>
          <div className="text-sm text-text">
            {job.target_lang}
            {job.lang_code && (
              <span className="ml-2 font-mono text-xs text-faint">({job.lang_code})</span>
            )}
          </div>
        </section>

        {/* Status + Duration + Cues */}
        <div className="grid grid-cols-2 gap-3">
          <section>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
              {t("dashboard.details.status")}
            </div>
            <JobStatusBadge job={job} />
          </section>
          <section>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
              {t("dashboard.details.duration")}
            </div>
            <div className="font-mono text-sm text-text">
              {job.duration_seconds ? formatDur(job.duration_seconds) : "—"}
            </div>
          </section>
        </div>

        {/* Cues */}
        <section>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
            {t("dashboard.details.cues")}
          </div>
          <div className="font-mono text-sm text-text">
            {job.total_cues > 0
              ? `${job.completed_cues} / ${job.total_cues}`
              : "—"}
          </div>
        </section>

        {/* Tokens + estimated cost */}
        <div className="grid grid-cols-2 gap-3">
          <section>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
              {t("dashboard.details.tokens")}
            </div>
            <div className="font-mono text-sm text-text">
              {(job.input_tokens || job.output_tokens)
                ? `${formatTokens(job.input_tokens)} / ${formatTokens(job.output_tokens)}`
                : "—"}
            </div>
          </section>
          <section>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
              {t("dashboard.details.cost")}
            </div>
            <div className="font-mono text-sm text-text">
              {job.est_cost === null || job.est_cost === undefined
                ? <span className="italic text-faint">{t("dashboard.details.costLocal")}</span>
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
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
            {t("dashboard.details.translatedBy")}
          </div>
          <div className="text-sm text-text">
            {job.used_connections
              ? job.used_connections
              : <span className="italic text-faint">{t("dashboard.details.notRecorded")}</span>}
          </div>
        </section>

        {/* Job ID */}
        <section>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
            {t("dashboard.details.jobId")}
          </div>
          <div className="font-mono text-sm text-text">#{job.id}</div>
        </section>

        {/* Error — plain-language cause first, raw text kept for bug reports */}
        {job.error && (
          <section>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
              {t("dashboard.details.error")}
            </div>
            {errorHint && <p className="mb-2 text-xs text-muted">{t(errorHint)}</p>}
            <div className="select-all whitespace-pre-wrap rounded-sm bg-danger-soft p-3 font-mono text-xs text-danger">
              {job.error}
            </div>
          </section>
        )}

        {/* Analysis context */}
        {job.analysis_context && (
          <section>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
              {t("dashboard.details.analysis")}
            </div>
            <div className="max-h-48 overflow-y-auto rounded-sm border border-border bg-surface-raised p-3 text-xs text-muted">
              {job.analysis_context}
            </div>
          </section>
        )}

        {/* Footer actions */}
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={() => { onOpenLogs(job.id); onClose(); }}
            className="flex-1 rounded-sm border border-border bg-surface-raised px-3 py-2 text-sm font-medium text-text hover:bg-surface-highlight"
          >
            {t("dashboard.details.openLogs")}
          </button>
          <NavLink
            to={`/jobs/${job.id}`}
            onClick={onClose}
            className="flex-1 rounded-sm border border-accent-line bg-accent-soft px-3 py-2 text-center text-sm font-medium text-accent hover:brightness-110"
          >
            {t("dashboard.details.fullPage")}
          </NavLink>
        </div>
      </div>
    </Drawer>
  );
}
