import { useTranslation } from "../../i18n";
import type { Job } from "../../types";
import { ActionButton } from "../../ui/primitives";
import { ActiveJobCard } from "../dashboard/ActiveJobCard";
import { recentDurationsSeconds } from "../dashboard/eta";

const RECENT_DURATION_SAMPLE = 20;

interface QueueBandProps {
  jobs: Job[];
  queueRunning: boolean;
  onRunAll: () => void;
  onStop: () => void;
  busy: boolean;
}

/** The live queue above every view: what is translating, what waits, and the one control to start or stop it. */
export function QueueBand({ jobs, queueRunning, onRunAll, onStop, busy }: QueueBandProps) {
  const { t } = useTranslation();
  const pendingJobs = jobs.filter((job) => job.status === "pending");
  const activeJobs = jobs.filter((job) => job.status === "translating");
  if (!queueRunning && pendingJobs.length === 0 && activeJobs.length === 0) return null;

  const recentDurations = recentDurationsSeconds(
    jobs.filter((job) => job.status === "done"),
    RECENT_DURATION_SAMPLE,
  );
  const stateLabel = t(queueRunning ? "app.queueRunning" : "app.queueIdle");

  return (
    <section aria-label={stateLabel} className="shrink-0 space-y-2 border-b border-border bg-surface-raised px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-text">
          <span
            aria-hidden="true"
            className={`h-2 w-2 shrink-0 rounded-full ${queueRunning ? "bg-success animate-pulse" : "bg-faint"}`}
          />
          {stateLabel}
        </span>
        <span className="text-sm text-muted">
          {t("dashboard.stat.pending")} <span className="font-mono tabular-nums text-text">{pendingJobs.length}</span>
        </span>
        <div className="ml-auto">
          {queueRunning ? (
            <ActionButton variant="danger" size="sm" onClick={onStop} busy={busy}>
              {t("dashboard.stop")}
            </ActionButton>
          ) : (
            <ActionButton
              variant="success"
              size="sm"
              onClick={onRunAll}
              busy={busy}
              disabled={pendingJobs.length === 0}
            >
              {t("dashboard.runAll")}
            </ActionButton>
          )}
        </div>
      </div>
      {activeJobs.map((job, index) => (
        <ActiveJobCard
          key={job.id}
          job={job}
          pendingCount={index === 0 ? pendingJobs.length : 0}
          recentDurationsSeconds={recentDurations}
        />
      ))}
    </section>
  );
}
