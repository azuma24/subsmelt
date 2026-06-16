import type { TFunction } from "i18next";
import type { JobRow } from "../../types";
import { StatusStrip, StatCard } from "../../ui/primitives";
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
  doneJobs: JobRow[];
  errorJobs: JobRow[];
  /** Summed token usage + approximate cost across all visible jobs. */
  usageTotals: { inputTokens: number; outputTokens: number; cost: number; hasCost: boolean };
  /** Soft monthly token budget (0 = unlimited) — display-only indicator. */
  tokenBudget: number;
  onSelectStatus: (key: string) => void;
  t: TFunction;
}

export function DashboardHero({
  statusSegments,
  statusFilter,
  activeJobs,
  pendingJobs,
  doneJobs,
  errorJobs,
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
  const tokenCardLabel = `${t("dashboard.stat.tokens")} · ${budgetStr}`;
  return (
    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:gap-4">
      {/* Left: Status strip + active job */}
      <div className="min-w-0 flex-1 space-y-3">
        {/* StatusStrip — condensed stat row, each segment clickable to filter */}
        <StatusStrip
          segments={statusSegments}
          activeKey={statusFilter}
          onSelect={onSelectStatus}
        />
        {activeJobs.length > 0 && (
          <div className="flex flex-col gap-2">
            {activeJobs.map((j, i) => (
              <ActiveJobCard key={j.id} job={j} pendingCount={i === 0 ? pendingJobs.length : 0} />
            ))}
          </div>
        )}
      </div>
      {/* Right: quick-stat cards (kept for xl layout, condensed) — xl:w-[34rem] */}
      <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-2 xl:grid-cols-4 xl:w-[34rem]">
        <StatCard label={t("dashboard.stat.pending")} value={pendingJobs.length} color="text-[var(--yellow)]" onClick={() => onSelectStatus("pending")} />
        <StatCard label={t("dashboard.stat.translating")} value={activeJobs.length} color="text-[var(--accent)]" onClick={() => onSelectStatus("translating")} />
        <StatCard label={t("dashboard.stat.done")} value={doneJobs.length} color="text-[var(--green)]" onClick={() => onSelectStatus("done")} />
        <StatCard
          label={t("dashboard.stat.errors")}
          value={errorJobs.length}
          color="text-[var(--red)]"
          onClick={() => onSelectStatus("error")}
        />
        {/* Tokens / est. cost — unobtrusive, spans the full width below the 4 cards */}
        <div className="col-span-2 xl:col-span-4">
          <StatCard
            label={tokenCardLabel}
            value={formatTokens(totalTokens)}
            color={overBudget ? "text-[var(--red)]" : "text-[var(--text)]"}
          />
        </div>
      </div>
    </div>
  );
}
