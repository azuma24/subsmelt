import type { TFunction } from "i18next";
import type { JobRow } from "../../types";
import { ActiveJobCard } from "./ActiveJobCard";
import { formatTokens, formatCost } from "../../lib";

interface StatusSegment {
  key: string;
  label: string;
  count: number;
  color: string;
  activeColor: string;
}

interface DashboardHeroProps {
  statusSegments: StatusSegment[];
  statusFilter: string;
  activeJobs: JobRow[];
  pendingJobs: JobRow[];
  /** Recently completed jobs — their durations drive the queue-time projection. */
  completedJobs?: JobRow[];
  /** Summed token usage + approximate cost across all visible jobs. */
  usageTotals: { inputTokens: number; outputTokens: number; cost: number; hasCost: boolean };
  /** Soft monthly token budget (0 = unlimited) — display-only indicator. */
  tokenBudget: number;
  onSelectStatus: (key: string) => void;
  t: TFunction;
}

// Cockpit Grid metric band — one full-width row of dense cells (status filters +
// token usage), replacing the old StatusStrip + duplicate stat-card grid. Big
// mono numerals, tiny uppercase labels, hairline dividers.
export function DashboardHero({
  statusSegments,
  statusFilter,
  activeJobs,
  pendingJobs,
  completedJobs = [],
  usageTotals,
  tokenBudget,
  onSelectStatus,
  t,
}: DashboardHeroProps) {
  const totalTokens = usageTotals.inputTokens + usageTotals.outputTokens;
  const costStr = usageTotals.hasCost ? `≈ ${formatCost(usageTotals.cost)}` : t("dashboard.stat.costLocal");
  const budgetStr = tokenBudget > 0
    ? t("dashboard.stat.tokenBudget", { used: formatTokens(totalTokens), budget: formatTokens(tokenBudget) })
    : costStr;
  const overBudget = tokenBudget > 0 && totalTokens > tokenBudget;
  // Last 20 finished jobs are enough for a stable median without letting ancient
  // runs (different model, different settings) skew the projection.
  const recentDurationsSeconds = completedJobs
    .map((job) => job.duration_seconds)
    .filter((seconds): seconds is number => typeof seconds === "number" && seconds > 0)
    .slice(-20);

  const cellLabel = "text-[10px] font-medium uppercase tracking-[0.7px] leading-none";
  const cellValue = "mt-2 font-mono text-[20px] font-semibold tabular-nums leading-none";

  // These cells are the app's only status filter (the queue toolbar's duplicate
  // pill row was removed), and the band grows by one when skipped jobs exist.
  // Both column counts are written out in full so Tailwind's scanner sees them.
  const bandClass = statusSegments.length > 5
    ? "grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3 lg:grid-cols-7"
    : "grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3 lg:grid-cols-6";

  return (
    <div className="flex flex-col gap-3">
      {/* Hairline grid: gap-px over a border-colored bg draws the dividers and
          stays responsive — 2 cols on phones, 3 on small, all in a row on lg. */}
      <div className={bandClass}>
        {statusSegments.map((seg) => {
          const isActive = statusFilter === seg.key;
          return (
            <button
              key={seg.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelectStatus(seg.key)}
              className={`px-3.5 py-2.5 text-left transition-colors ${isActive ? "bg-[var(--surface-2)]" : "bg-[var(--surface)] hover:bg-[var(--surface-2)]"}`}
            >
              <div className={`${cellLabel} ${isActive ? "text-[var(--accent)]" : "text-[var(--text-3)]"}`}>{seg.label}</div>
              {/* A zero count stays muted — a red "0 errors" reads as an alarm
                  about nothing. Status colors only earn their tone with content. */}
              <div className={`${cellValue} ${seg.count === 0 && !isActive ? "text-[var(--text-3)]" : isActive ? seg.activeColor : seg.color}`}>{seg.count}</div>
            </button>
          );
        })}
        {/* Tokens / est. cost — display-only trailing cell, not a filter. Every
            cell to its left is a button; this one is a div with the same padding
            and type, so it read as clickable. A recessed fill plus a heavier
            leading rule marks it as a readout instead. */}
        <div className="border-l-2 border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5">
          <div className={`${cellLabel} truncate ${overBudget ? "text-[var(--red)]" : "text-[var(--text-3)]"}`}>{overBudget && <span aria-hidden="true">⚠ </span>}{t("dashboard.stat.tokens")} · {budgetStr}</div>
          <div className={`${cellValue} ${overBudget ? "text-[var(--red)]" : "text-[var(--text)]"}`}>{formatTokens(totalTokens)}</div>
        </div>
      </div>

      {activeJobs.length > 0 && (
        <div className="flex flex-col gap-2">
          {activeJobs.map((j, i) => (
            <ActiveJobCard
              key={j.id}
              job={j}
              pendingCount={i === 0 ? pendingJobs.length : 0}
              recentDurationsSeconds={recentDurationsSeconds}
            />
          ))}
        </div>
      )}
    </div>
  );
}
