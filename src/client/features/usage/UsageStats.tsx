import type { ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { formatCost, formatTokens } from "../../lib";
import type { UsageReport } from "../../types";
import { Icon } from "../../ui/Icon";
import { ProgressSmall } from "../../ui/primitives";

const LABEL = "text-xs font-medium uppercase tracking-[0.7px] leading-none";
const VALUE = "mt-2 font-mono text-lg font-semibold tabular-nums leading-none";

function Tile({
  label,
  value,
  sub,
  tone = "text-text",
  className = "",
}: {
  label: ReactNode;
  value: string;
  sub?: ReactNode;
  tone?: string;
  className?: string;
}) {
  return (
    <div className={`bg-surface px-4 py-3 ${className}`}>
      <div className={`${LABEL} ${tone === "text-text" ? "text-faint" : tone}`}>{label}</div>
      <div className={`${VALUE} ${tone}`}>{value}</div>
      {sub && <div className="mt-2 text-xs text-faint">{sub}</div>}
    </div>
  );
}

/** The report's headline numbers, in the dashboard's hairline grid. */
export function UsageStats({ totals, budget }: Pick<UsageReport, "totals" | "budget">) {
  const { t } = useTranslation();
  const overBudget = budget !== null && budget.monthTokens > budget.monthlyTokens;
  const grid = budget
    ? "grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3 lg:grid-cols-7"
    : "grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3 lg:grid-cols-6";

  return (
    <div className={grid}>
      <Tile label={t("usage.stat.total")} value={formatTokens(totals.totalTokens)} />
      <Tile
        label={t("usage.stat.input")}
        value={formatTokens(totals.inputTokens)}
        sub={totals.cacheReadTokens > 0 && t("usage.stat.cached", { tokens: formatTokens(totals.cacheReadTokens) })}
      />
      <Tile
        label={t("usage.stat.output")}
        value={formatTokens(totals.outputTokens)}
        sub={totals.reasoningTokens > 0 && t("usage.stat.reasoning", { tokens: formatTokens(totals.reasoningTokens) })}
      />
      <Tile
        label={t("usage.stat.cost")}
        value={totals.costUsd === null ? t("usage.stat.costNa") : `≈ ${formatCost(totals.costUsd)}`}
        sub={totals.costUsd === null && t("usage.stat.costNaHelp")}
      />
      <Tile label={t("usage.stat.calls")} value={totals.calls.toLocaleString()} />
      <Tile label={t("usage.stat.files")} value={totals.files.toLocaleString()} />
      {budget && (
        <Tile
          className="col-span-2 sm:col-span-3 lg:col-span-1"
          tone={overBudget ? "text-danger" : "text-text"}
          label={
            <span className="inline-flex items-center gap-1">
              {overBudget && <Icon name="warning" />}
              {overBudget ? t("usage.stat.overBudget") : t("usage.stat.budget")}
            </span>
          }
          value={formatTokens(budget.monthTokens)}
          sub={
            <>
              <span>{t("usage.stat.budgetOf", { budget: formatTokens(budget.monthlyTokens) })}</span>
              <div className="mt-1">
                <ProgressSmall pct={(budget.monthTokens / budget.monthlyTokens) * 100} />
              </div>
            </>
          }
        />
      )}
    </div>
  );
}
