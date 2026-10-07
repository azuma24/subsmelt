import { useParams } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { useJobPreview, useJobsQuery } from "../../hooks";
import { formatDur } from "../../lib";
import type { Job } from "../../types";
import { DetailCard, EmptyHint, ProgressSmall } from "../../ui/primitives";
import { JobStatusBadge } from "./JobStatusBadge";

export function JobDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const jobId = Number(id);
  const jobsQuery = useJobsQuery();
  const previewQuery = useJobPreview(Number.isFinite(jobId) ? jobId : null);
  const job = (jobsQuery.data?.jobs || []).find((j: Job) => j.id === jobId);

  // Don't flash "not found" while the jobs list is still loading (deep-link nav).
  if (jobsQuery.isLoading && !jobsQuery.data) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <EmptyHint text={t("errors.loading")} />
      </div>
    );
  }
  if (!job) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <EmptyHint text={t("jobDetail.notFound")} />
      </div>
    );
  }

  const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-4 md:p-6">
      <section className="rounded-md border border-border bg-surface p-6 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-faint">{t("jobDetail.title", { id: job.id })}</div>
            <h1 className="mt-1 break-all text-xl font-semibold">{job.srt_path.split("/").pop()}</h1>
            <p className="mt-2 text-sm text-muted">
              {job.target_lang} • {job.lang_code}
            </p>
          </div>
          <JobStatusBadge job={job} />
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <DetailCard label={t("app.sourcePath")} value={job.srt_path} mono />
          <DetailCard label={t("app.outputPath")} value={job.output_path} mono />
          <DetailCard label={t("app.duration")} value={job.duration_seconds ? formatDur(job.duration_seconds) : "—"} />
          <DetailCard
            label={t("app.priorityForce")}
            value={`${job.priority > 0 ? t("app.pinned") : t("app.normal")} • ${job.force ? t("app.forceEnabled") : t("app.normalMode")}`}
          />
        </div>
        {job.status === "translating" && (
          <div className="mt-6">
            <ProgressSmall pct={pct} large />
            <div className="mt-2 text-xs text-faint">
              {t("dashboard.cues", { completed: job.completed_cues, total: job.total_cues })}
            </div>
          </div>
        )}
        {job.error && (
          <div className="mt-6 rounded-md border border-danger-line bg-danger-soft p-4 text-xs text-danger whitespace-pre-wrap">
            {job.error}
          </div>
        )}
      </section>

      <section className="rounded-md border border-border bg-surface p-6 md:p-6">
        <h2 className="text-base font-semibold">{t("jobDetail.context")}</h2>
        {previewQuery.isLoading && <div className="mt-4 text-sm text-faint">{t("app.loadingPreview")}</div>}
        {previewQuery.data?.analysis && (
          <div className="mt-4 rounded-md border border-border bg-surface-raised p-4">
            <pre className="whitespace-pre-wrap text-xs text-text leading-relaxed">{previewQuery.data.analysis}</pre>
          </div>
        )}
        {!previewQuery.isLoading && !previewQuery.data?.analysis && (
          <div className="mt-4 text-sm text-faint">{t("jobDetail.noContext")}</div>
        )}
      </section>

      <section className="rounded-md border border-border bg-surface p-6 md:p-6">
        <h2 className="text-base font-semibold">{t("app.previewSample")}</h2>
        {previewQuery.isLoading && <div className="mt-4 text-sm text-faint">{t("app.loadingPreview")}</div>}
        {previewQuery.data && (
          <div className="mt-4 space-y-3">
            {previewQuery.data.lines.slice(0, 8).map((line) => (
              <div key={line.index} className="rounded-md border border-border bg-surface-raised p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-faint">
                  <span>#{line.index}</span>
                </div>
                <div className="space-y-2 text-xs">
                  <div>
                    <div className="mb-1 text-xs uppercase text-faint">{t("dashboard.preview.colOriginal")}</div>
                    <div className="text-muted">{line.original}</div>
                  </div>
                  <div>
                    <div className="mb-1 text-xs uppercase text-faint">{t("dashboard.preview.colTranslated")}</div>
                    <div className="text-text">{line.translated}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
