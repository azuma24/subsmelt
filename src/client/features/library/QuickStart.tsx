import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { str } from "../../lib/settings-value";
import { useSettingsQuery, useTasksQuery } from "../../hooks";
import type { Job } from "../../types";
import { Icon } from "../../ui/Icon";

const SETUP_DISMISSED_KEY = "subsmelt_setup_dismissed";

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
  onStop: () => void;
}

/** First-run checklist; hides itself for good once a job finishes or the person dismisses it. */
export function QuickStart({ jobs, queueRunning, onScan, onRunAll, onStop }: QuickStartProps) {
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
      hint: hasLlmConfig ? t("dashboard.quickStart.done") : t("dashboard.quickStart.llmHint"),
      action: t("dashboard.quickStart.openSettings"),
      onClick: () => navigate("/settings"),
    },
    {
      done: enabledTaskCount > 0,
      title: t("dashboard.quickStart.tasksTitle"),
      hint: enabledTaskCount > 0 ? t("dashboard.quickStart.done") : t("dashboard.quickStart.tasksHint"),
      action: t("dashboard.quickStart.openTranslations"),
      onClick: () => navigate("/settings/languages"),
    },
    {
      done: mediaFound,
      title: t("dashboard.quickStart.mediaTitle"),
      hint: mediaFound ? t("dashboard.quickStart.done") : t("dashboard.quickStart.mediaHint"),
      action: t("dashboard.quickStart.scanNow"),
      onClick: onScan,
    },
    {
      done: queueRunning,
      title: t("dashboard.quickStart.queueTitle"),
      hint: queueRunning ? t("dashboard.quickStart.queueRunning") : t("dashboard.quickStart.queueIdle"),
      action: queueRunning ? t("dashboard.quickStart.stopQueue") : t("dashboard.quickStart.runQueue"),
      onClick: queueRunning ? onStop : onRunAll,
    },
  ];
  if (dismissed || steps.every((step) => step.done)) return null;

  return (
    <section aria-label={t("dashboard.quickStart.title")} className="shrink-0 border-b border-border px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-faint">{t("dashboard.quickStart.title")}</span>
        <button
          type="button"
          onClick={() => {
            persistDismissed();
            setDismissed(true);
          }}
          className="text-xs text-faint hover:text-text"
        >
          {t("dashboard.quickStart.dismiss")}
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step) => (
          <div
            key={step.title}
            className={`rounded-md border p-3 ${step.done ? "border-success-line bg-success-soft" : "border-border bg-surface"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-text">{step.title}</div>
              <Icon name={step.done ? "done" : "pending"} className={step.done ? "text-success" : "text-warning"} />
            </div>
            <div className="mt-1 text-xs text-muted">{step.hint}</div>
            {!step.done && (
              <button type="button" onClick={step.onClick} className="mt-2 text-xs text-accent">
                {step.action}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
