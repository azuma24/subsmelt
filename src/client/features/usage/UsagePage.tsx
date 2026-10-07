import { useId } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "../../api";
import { useUsageQuery } from "../../hooks";
import { useTranslation } from "../../i18n";
import { formatCost, formatTokens, getErrorMessage } from "../../lib";
import { USAGE_RANGES, type UsageDay, type UsageRange, type UsageReport } from "../../types";
import { useConfirm } from "../../ui/ConfirmModal";
import { Icon } from "../../ui/Icon";
import { ActionButton, EmptyHint, PageHeader, RowActionsMenu } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { useToast } from "../../ui/Toast";
import { axisCost, axisTokens } from "./chart-scale";
import { type ChartSeries, DailyBarChart } from "./DailyBarChart";
import { ByKindList, ByModelList } from "./UsageBreakdowns";
import { UsageStats } from "./UsageStats";
import { RecentCallsTable, TopFilesTable } from "./UsageTables";

const DEFAULT_RANGE: UsageRange = "30d";

const isRange = (value: string | null): value is UsageRange =>
  value !== null && (USAGE_RANGES as readonly string[]).includes(value);

function RangePicker({ range, onChange }: { range: UsageRange; onChange: (range: UsageRange) => void }) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <div className="flex items-center gap-2">
      <span id={labelId} className="sr-only">
        {t("usage.range.label")}
      </span>
      <div role="group" aria-labelledby={labelId} className="flex overflow-hidden rounded-sm border border-border">
        {USAGE_RANGES.map((r) => (
          <button
            type="button"
            key={r}
            onClick={() => onChange(r)}
            aria-pressed={range === r}
            className={`min-h-touch min-w-touch border-r border-border px-3 text-xs font-medium transition-colors last:border-r-0 ${
              range === r
                ? "bg-accent-soft text-accent"
                : "bg-surface-raised text-muted hover:bg-surface-highlight hover:text-text"
            }`}
          >
            {t(`usage.range.${r}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function UsageSkeleton() {
  const block = "animate-pulse rounded-md bg-surface-raised motion-reduce:animate-none";
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-16 bg-surface" />
        ))}
      </div>
      <div className={`h-64 ${block}`} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={`h-48 ${block}`} />
        <div className={`h-48 ${block}`} />
      </div>
    </div>
  );
}

function UsageBody({ report }: { report: UsageReport }) {
  const { t } = useTranslation();
  const days = report.daily;
  const first = days[0]?.day ?? "";
  const last = days[days.length - 1]?.day ?? "";
  const peak = days.reduce((best, d) =>
    d.inputTokens + d.outputTokens > best.inputTokens + best.outputTokens ? d : best,
  );
  const tokenSeries: ChartSeries[] = [
    {
      key: "input",
      label: t("usage.chart.input"),
      fillClass: "fill-chart-1",
      keyClass: "bg-chart-1",
      value: (d) => d.inputTokens,
    },
    {
      key: "output",
      label: t("usage.chart.output"),
      fillClass: "fill-chart-2",
      keyClass: "bg-chart-2",
      value: (d) => d.outputTokens,
    },
  ];
  const costSeries: ChartSeries[] = [
    {
      key: "cost",
      label: t("usage.table.cost"),
      fillClass: "fill-accent",
      keyClass: "bg-accent",
      value: (d) => d.costUsd ?? 0,
    },
  ];
  const callsDetail = {
    label: t("usage.table.calls"),
    value: (d: UsageDay) => d.calls.toLocaleString(),
    describe: (d: UsageDay) => t("usage.calls", { calls: d.calls.toLocaleString() }),
  };

  return (
    <div className="flex flex-col gap-4">
      <UsageStats totals={report.totals} budget={report.budget} />
      <DailyBarChart
        title={t("usage.chart.tokensTitle")}
        days={days}
        series={tokenSeries}
        format={formatTokens}
        axisFormat={axisTokens}
        detail={callsDetail}
        summary={t("usage.chart.tokensSummary", {
          from: first,
          to: last,
          total: formatTokens(report.totals.totalTokens),
          peak: formatTokens(peak.inputTokens + peak.outputTokens),
          peakDay: peak.day,
        })}
      />
      {days.some((d) => d.costUsd !== null) && (
        <DailyBarChart
          title={t("usage.chart.costTitle")}
          days={days}
          series={costSeries}
          format={formatCost}
          axisFormat={axisCost}
          summary={t("usage.chart.costSummary", { from: first, to: last, total: formatCost(report.totals.costUsd) })}
        />
      )}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ByModelList rows={report.byModel} />
        <ByKindList rows={report.byKind} />
      </div>
      <TopFilesTable rows={report.topFiles} />
      <RecentCallsTable rows={report.recent} />
    </div>
  );
}

/** Settings → Usage: where the tokens went, per day, model, call type and file. */
export function UsagePage() {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get("range");
  const range = isRange(rangeParam) ? rangeParam : DEFAULT_RANGE;
  const query = useUsageQuery(range);
  const report = query.data;

  const setRange = (next: UsageRange) =>
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (next === DEFAULT_RANGE) updated.delete("range");
        else updated.set("range", next);
        return updated;
      },
      { replace: true },
    );

  const clearHistory = async () => {
    const ok = await confirm({
      title: t("usage.confirm.title"),
      message: t("usage.confirm.message"),
      confirmLabel: t("usage.confirm.confirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      const { deleted } = await api.deleteUsage();
      addToast(t("usage.toast.cleared", { deleted: deleted.toLocaleString() }), "info");
    } catch (e: unknown) {
      addToast(t("usage.toast.clearFailed", { message: getErrorMessage(e) }), "error");
    }
    void queryClient.invalidateQueries({ queryKey: ["usage"] });
  };

  const content = (() => {
    if (report) {
      if (report.totals.calls === 0) {
        return (
          <EmptyHint
            icon="usage"
            text={range === "all" ? t("usage.empty.title") : t("usage.empty.rangeTitle")}
            subtext={t("usage.empty.body")}
          />
        );
      }
      return (
        <div className={`transition-opacity duration-fast ${query.isPlaceholderData ? "opacity-60" : ""}`}>
          <UsageBody report={report} />
        </div>
      );
    }
    if (query.isError) {
      return (
        <InlineError
          message={t("usage.loadFailed", { message: getErrorMessage(query.error) })}
          onRetry={() => void query.refetch()}
        />
      );
    }
    return <UsageSkeleton />;
  })();

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title={t("usage.title")}
        subtitle={t("usage.subtitle")}
        middle={<RangePicker range={range} onChange={setRange} />}
        actions={
          <>
            <ActionButton variant="ghost" size="sm" onClick={() => void query.refetch()} busy={query.isFetching}>
              <Icon name="retry" /> {t("usage.refresh")}
            </ActionButton>
            <RowActionsMenu items={[{ label: t("usage.clear"), danger: true, onClick: clearHistory }]} />
          </>
        }
      />
      <div className="flex-1 p-4">
        <div className="mx-auto max-w-6xl">{content}</div>
      </div>
    </div>
  );
}
