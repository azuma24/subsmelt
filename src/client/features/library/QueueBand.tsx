import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import type { Job } from "../../types";
import { ActionButton } from "../../ui/primitives";
import { elapsedSince, estimateJobEta, estimateQueueEta, formatEta, recentDurationsSeconds } from "../dashboard/eta";

const RECENT_DURATION_SAMPLE = 20;
const ETA_TICK_MS = 5_000;

interface QueueBandProps {
  jobs: Job[];
  queueRunning: boolean;
  onRunAll: () => void;
  onStop: () => void;
  busy: boolean;
}

/** The live queue as one line above every view: what is translating, what waits, and Run all or Stop. */
export function QueueBand({ jobs, queueRunning, onRunAll, onStop, busy }: QueueBandProps) {
  const { t } = useTranslation();
  const pendingJobs = jobs.filter((job) => job.status === "pending");
  const activeJobs = jobs.filter((job) => job.status === "translating");
  if (!queueRunning && pendingJobs.length === 0 && activeJobs.length === 0) return null;

  const stateLabel = t(queueRunning ? "app.queueRunning" : "app.queueIdle");
  const queueEtaMs = estimateQueueEta(
    pendingJobs.length,
    recentDurationsSeconds(
      jobs.filter((job) => job.status === "done"),
      RECENT_DURATION_SAMPLE,
    ),
  );

  return (
    <section
      aria-label={stateLabel}
      className="flex min-h-touch shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface-raised px-4"
    >
      <span
        aria-hidden="true"
        title={stateLabel}
        className={`h-2 w-2 shrink-0 rounded-full ${queueRunning ? "bg-success animate-pulse" : "bg-faint"}`}
      />
      {activeJobs.length > 0 ? (
        <ActiveJobLine job={activeJobs[0]} others={activeJobs.length - 1} />
      ) : (
        <span className="min-w-0 flex-1 text-sm font-medium text-text">{stateLabel}</span>
      )}
      {pendingJobs.length > 0 && (
        <span
          className="shrink-0 text-xs text-muted"
          title={queueEtaMs === null ? undefined : t("dashboard.queueEta", { time: formatEta(queueEtaMs) })}
        >
          {t("dashboard.moreInQueue", { count: pendingJobs.length })}
        </span>
      )}
      <div className="ml-auto">
        {queueRunning ? (
          <ActionButton variant="danger" size="sm" onClick={onStop} busy={busy}>
            {t("dashboard.stop")}
          </ActionButton>
        ) : (
          <ActionButton variant="success" size="sm" onClick={onRunAll} busy={busy} disabled={pendingJobs.length === 0}>
            {t("dashboard.runAll")}
          </ActionButton>
        )}
      </div>
    </section>
  );
}

function ActiveJobLine({ job, others }: { job: Job; others: number }) {
  const { t } = useTranslation();
  // Progress arrives over SSE, but elapsed time advances on its own; tick so the
  // estimate keeps falling between cue updates instead of looking frozen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ETA_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // total_cues === 0 means the context analysis phase is still running.
  const analysing = job.total_cues === 0;
  const pct = analysing ? 0 : Math.round((job.completed_cues / job.total_cues) * 100);
  const elapsedMs = elapsedSince(job.started_at, now);
  const eta =
    elapsedMs === null ? null : estimateJobEta({ completed: job.completed_cues, total: job.total_cues, elapsedMs });
  const name = job.srt_path.split("/").pop();

  return (
    <div className="flex min-w-0 flex-1 basis-56 items-center gap-3" title={t("app.currentlyTranslating")}>
      <span className="min-w-0 truncate text-sm font-medium text-text">
        {name} → {job.lang_code}
      </span>
      {others > 0 && <span className="shrink-0 text-xs text-muted">{`+${others}`}</span>}
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={analysing ? undefined : pct}
        aria-label={name}
        className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-surface-highlight sm:w-24"
      >
        <span
          className={`block h-1 rounded-full ${analysing ? "w-full animate-pulse bg-accent-soft" : "bg-accent"}`}
          style={analysing ? undefined : { width: `${pct}%` }}
        />
      </span>
      <span
        className="min-w-0 truncate font-mono text-xs text-muted"
        title={eta ? t("dashboard.cuesPerMinute", { rate: Math.round(eta.cuesPerMinute) }) : undefined}
      >
        {analysing ? t("dashboard.analysing") : `${pct}%`}
        {eta && ` · ${t("dashboard.etaLeft", { time: formatEta(eta.remainingMs) })}`}
      </span>
    </div>
  );
}
