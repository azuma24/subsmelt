import { useTranslation } from "react-i18next";
import type { JobRow } from "../../types";

interface ActiveJobCardProps {
  job: JobRow;
  pendingCount: number;
}

export function ActiveJobCard({ job, pendingCount }: ActiveJobCardProps) {
  const { t } = useTranslation();
  const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;
  return (
    <section className="rounded-3xl border border-blue-800/40 bg-blue-900/10 p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-blue-300">{t("app.currentlyTranslating")}</p>
          <h2 className="truncate text-base font-semibold text-white">{job.srt_path.split("/").pop()} → {job.lang_code}</h2>
        </div>
        <div className="text-right text-xs text-gray-500">{t("dashboard.moreInQueue", { count: pendingCount })}</div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <div className="h-2 flex-1 rounded-full bg-gray-800">
          <div className="h-2 rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="w-16 shrink-0 text-right text-xs text-gray-400">{pct}%</div>
      </div>
      <div className="mt-2 text-xs text-gray-500">{t("dashboard.cues", { completed: job.completed_cues, total: job.total_cues })}</div>
    </section>
  );
}
