import { useTranslation } from "react-i18next";
import { ActionButton } from "../../ui/primitives";

export interface SetupStep {
  key: string;
  done: boolean;
  title: string;
  hint: string;
  actionLabel: string;
  onAction: () => void;
}

/**
 * First-run signpost for Settings. The audit's complaint (H3) was that a new
 * operator lands on ~60 settings with no indication of what actually needs
 * doing. This is deliberately *not* a second wizard — the Dashboard already has
 * a quick-start checklist and duplicating it would give two competing
 * onboarding flows. It reuses that checklist's copy and simply tells you, from
 * inside Settings, what is still outstanding and where to go.
 *
 * Self-clearing: renders nothing once every step is satisfied, so there is no
 * dismiss control to get wrong and it reappears if a step regresses (e.g. the
 * last translation target is deleted).
 */
export function SetupProgress({ steps }: { steps: SetupStep[] }) {
  const { t } = useTranslation();
  const doneCount = steps.filter((s) => s.done).length;
  if (steps.length === 0 || doneCount === steps.length) return null;

  const remaining = steps.filter((s) => !s.done);

  return (
    <section
      aria-labelledby="setup-progress-title"
      className="mb-3.5 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-dim)] p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="setup-progress-title" className="text-[13px] font-semibold text-[var(--text)]">
          {t("dashboard.quickStart.title")}
        </h2>
        {/* Progress as text, not just a bar — it has to survive being read aloud. */}
        <span className="text-[11.5px] text-[var(--text-2)]">
          {t("settings.setup.progress", { done: doneCount, total: steps.length })}
        </span>
      </div>

      <ul role="list" className="mt-3 space-y-2">
        {remaining.map((step) => (
          <li
            key={step.key}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          >
            <span aria-hidden="true" className="text-[13px] text-[var(--text-3)]">○</span>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-[var(--text)]">{step.title}</div>
              <div className="text-[11.5px] leading-6 text-[var(--text-2)]">{step.hint}</div>
            </div>
            <ActionButton variant="ghost" size="sm" onClick={step.onAction}>
              {step.actionLabel}
            </ActionButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
