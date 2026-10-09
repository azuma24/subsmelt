import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { str } from "../../lib/settings-value";
import { useSettingsQuery, useTasksQuery } from "../../hooks";
import type { Job } from "../../types";
import { Icon } from "../../ui/Icon";

const SETUP_DISMISSED_KEY = "subsmelt_setup_dismissed";

// Side by side on wide screens, stacked on phones; written out in full so Tailwind's scanner sees them.
const COLUMNS: Record<number, string> = {
  1: "",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-2 xl:grid-cols-4",
};

function readDismissed(): boolean {
  try {
    return localStorage.getItem(SETUP_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function persistDismissed() {
  try {
    localStorage.setItem(SETUP_DISMISSED_KEY, "1");
  } catch {
    /* storage unavailable: the checklist just comes back next visit */
  }
}

interface QuickStartProps {
  jobs: Job[];
  queueRunning: boolean;
  onScan: () => void;
  onRunAll: () => void;
}

/**
 * First-run checklist listing only the steps left; hides itself for good once
 * a job finishes or the person dismisses it.
 */
export function QuickStart({ jobs, queueRunning, onScan, onRunAll }: QuickStartProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const settings = useSettingsQuery().data || {};
  const tasks = useTasksQuery().data || [];
  const [dismissed, setDismissed] = useState(readDismissed);
  const hasDoneJob = jobs.some((job) => job.status === "done");

  useEffect(() => {
    if (dismissed || !hasDoneJob) return;
    persistDismissed();
    setDismissed(true);
  }, [hasDoneJob, dismissed]);

  // Server-computed: the legacy llm_endpoint/model keys carry non-empty defaults,
  // so checking them client-side reported "configured" on a brand-new install and
  // ticked the quick-start step before the user had set anything up. Only the
  // server can compare against the shipped seed.
  const hasLlmConfig = settings._llm_configured === true;
  const enabledTaskCount = tasks.filter((task) => task.enabled === 1).length;
  // The jobs list is transient — Clear finished empties it, and a rescan then
  // creates no jobs (outputs exist). Media discovered at least once is a sticky
  // server fact, so the step cannot regress into a dead end.
  const mediaFound =
    jobs.some((job) => ["pending", "translating", "done"].includes(job.status)) || str(settings.media_scanned) === "1";

  const steps = [
    {
      done: hasLlmConfig,
      title: t("dashboard.quickStart.llmTitle"),
      hint: t("dashboard.quickStart.llmHint"),
      action: t("dashboard.quickStart.openSettings"),
      onClick: () => navigate("/settings"),
    },
    {
      done: enabledTaskCount > 0,
      title: t("dashboard.quickStart.tasksTitle"),
      hint: t("dashboard.quickStart.tasksHint"),
      action: t("dashboard.quickStart.openTranslations"),
      onClick: () => navigate("/settings/languages"),
    },
    {
      done: mediaFound,
      title: t("dashboard.quickStart.mediaTitle"),
      hint: t("dashboard.quickStart.mediaHint"),
      action: t("dashboard.quickStart.scanNow"),
      onClick: onScan,
    },
    {
      done: queueRunning,
      title: t("dashboard.quickStart.queueTitle"),
      hint: t("dashboard.quickStart.queueIdle"),
      action: t("dashboard.quickStart.runQueue"),
      onClick: onRunAll,
    },
  ];
  const remaining = steps.filter((step) => !step.done);
  if (dismissed || remaining.length === 0) return null;

  return (
    <section aria-label={t("dashboard.quickStart.title")} className="shrink-0 border-b border-border px-4 pb-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold text-muted">{t("dashboard.quickStart.title")}</h2>
        <span className="text-xs text-faint">
          {t("settings.setup.progress", { done: steps.length - remaining.length, total: steps.length })}
        </span>
        <button
          type="button"
          onClick={() => {
            persistDismissed();
            setDismissed(true);
          }}
          className="ml-auto min-h-touch px-2 text-xs text-faint hover:text-text"
        >
          {t("dashboard.quickStart.dismiss")}
        </button>
      </div>
      <ul
        className={`grid gap-px overflow-hidden rounded-md border border-border bg-border ${COLUMNS[remaining.length]}`}
      >
        {remaining.map((step) => (
          <li key={step.title} className="flex min-h-touch min-w-0 items-center gap-2 bg-surface pl-3">
            <Icon name="pending" className="shrink-0 text-warning" />
            <span className="shrink-0 text-sm font-medium text-text">{step.title}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-muted" title={step.hint}>
              {step.hint}
            </span>
            <button
              type="button"
              onClick={step.onClick}
              className="min-h-touch shrink-0 px-3 text-sm font-medium text-accent hover:underline"
            >
              {step.action}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
