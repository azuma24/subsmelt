import { useTranslation } from "react-i18next";
import type { JobRow } from "../../types";

interface ActiveJobCardProps {
  job: JobRow;
  pendingCount: number;
}

export function ActiveJobCard({ job, pendingCount }: ActiveJobCardProps) {
  const { t } = useTranslation();
  const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;
  // total_cues === 0 means the context analysis phase is still running
  const isAnalysing = job.total_cues === 0;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-[var(--accent-border)] bg-[var(--surface)] px-4 py-[13px] sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.7px] text-[var(--accent)]">{t("app.currentlyTranslating")}</p>
        <h2 className="mt-0.5 truncate text-[13.5px] font-semibold text-[var(--text)]">{job.srt_path.split("/").pop()} → {job.lang_code}</h2>
        {pendingCount > 0 && <div className="mt-0.5 text-[11.5px] text-[var(--text-2)]">{t("dashboard.moreInQueue", { count: pendingCount })}</div>}
      </div>
      <div className="w-full sm:max-w-[200px]">
        <div className="h-[3px] overflow-hidden rounded-full bg-[var(--surface-3)]">
          {isAnalysing ? (
            <div className="h-[3px] w-full animate-pulse rounded-full bg-[var(--accent)]/50" />
          ) : (
            <div className="h-[3px] rounded-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
          )}
        </div>
        <div className="mt-1 text-right font-mono text-[11px] text-[var(--text-2)]">
          {isAnalysing
            ? t("dashboard.analysing", "Analysing context…")
            : `${pct}% · ${t("dashboard.cues", { completed: job.completed_cues, total: job.total_cues })}`}
        </div>
      </div>
    </section>
  );
}
