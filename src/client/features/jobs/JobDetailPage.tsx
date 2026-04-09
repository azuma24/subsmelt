import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useJobPreview, useJobsQuery } from "../../hooks";
import { formatDur } from "../../lib";
import type { JobRow } from "../../types";
import { DetailCard, EmptyHint, ProgressSmall, StatusBadge } from "../../ui/primitives";

export function JobDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const jobId = Number(id);
  const jobsQuery = useJobsQuery();
  const previewQuery = useJobPreview(Number.isFinite(jobId) ? jobId : null);
  const job = (jobsQuery.data?.jobs || []).find((j: JobRow) => j.id === jobId);

  if (!job) {
    return <div className="mx-auto max-w-4xl p-6"><EmptyHint text={t("jobDetail.notFound")} /></div>;
  }

  const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-4 md:p-6">
      <section className="rounded-3xl border border-gray-800 bg-gray-900/80 p-5 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-gray-500">{t("jobDetail.title", { id: job.id })}</div>
            <h1 className="mt-1 break-all text-2xl font-semibold">{job.srt_path.split("/").pop()}</h1>
            <p className="mt-2 text-sm text-gray-400">{job.target_lang} • {job.lang_code}</p>
          </div>
          <StatusBadge job={job} />
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <DetailCard label={t("app.sourcePath")} value={job.srt_path} mono />
          <DetailCard label={t("app.outputPath")} value={job.output_path} mono />
          <DetailCard label={t("app.duration")} value={job.duration_seconds ? formatDur(job.duration_seconds) : "—"} />
          <DetailCard label={t("app.priorityForce")} value={`${job.priority > 0 ? t("app.pinned") : t("app.normal")} • ${job.force ? t("app.forceEnabled") : t("app.normalMode")}`} />
        </div>
        {job.status === "translating" && <div className="mt-5"><ProgressSmall pct={pct} large /><div className="mt-2 text-xs text-gray-500">{t("dashboard.cues", { completed: job.completed_cues, total: job.total_cues })}</div></div>}
        {job.error && <div className="mt-5 rounded-2xl border border-red-900/40 bg-red-950/20 p-4 text-xs text-red-300 whitespace-pre-wrap">{job.error}</div>}
      </section>

      <section className="rounded-3xl border border-gray-800 bg-gray-900/80 p-5 md:p-6">
        <h2 className="text-lg font-semibold">{t("app.previewSample")}</h2>
        {previewQuery.isLoading && <div className="mt-4 text-sm text-gray-500">{t("app.loadingPreview")}</div>}
        {previewQuery.data && (
          <div className="mt-4 space-y-3">
            {previewQuery.data.lines.slice(0, 8).map((line) => (
              <div key={line.index} className="rounded-2xl border border-gray-800 bg-gray-950/40 p-3">
                <div className="mb-2 flex items-center justify-between text-[11px] text-gray-500"><span>#{line.index}</span></div>
                <div className="space-y-2 text-xs">
                  <div>
                    <div className="mb-1 text-[10px] uppercase text-gray-600">{t("dashboard.preview.colOriginal")}</div>
                    <div className="text-gray-300">{line.original}</div>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] uppercase text-gray-600">{t("dashboard.preview.colTranslated")}</div>
                    <div className="text-gray-100">{line.translated}</div>
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
