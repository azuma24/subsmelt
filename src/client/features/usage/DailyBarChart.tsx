import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "../../i18n";
import type { UsageDay } from "../../types";
import { niceTicks, sampledLabels, topRoundedBar } from "./chart-scale";

export interface ChartSeries {
  key: string;
  label: string;
  /** Tailwind fill and background classes for the series hue (marks and keys only, never text). */
  fillClass: string;
  keyClass: string;
  value: (day: UsageDay) => number;
}

interface DailyBarChartProps {
  title: string;
  days: UsageDay[];
  /** Stacked bottom to top, in this order. */
  series: ChartSeries[];
  format: (value: number) => string;
  /** Tick labels; shorter than `format` because the axis has little room. */
  axisFormat: (value: number) => string;
  /** One sentence for screen readers: range, total, peak. */
  summary: string;
  /** An extra table column, also a muted tooltip line, such as the call count. */
  detail?: { label: string; value: (day: UsageDay) => string; describe: (day: UsageDay) => string };
}

const DEFAULT_WIDTH = 640;
const PLOT_HEIGHT = 180;
const MARGIN = { top: 8, right: 4, bottom: 24, left: 48 };
const MAX_BAR = 24;
const SEGMENT_GAP = 2;
const BAR_RADIUS = 4;
const LABEL_GAP_PX = 72;
const TOOLTIP_WIDTH = 176;
/** Below this band width bars are slivers, so a hairline marks the active day. */
const THIN_BAND = 6;

function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || DEFAULT_WIDTH);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width) || DEFAULT_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * Daily bars, stacked when there is more than one series. Pointer, touch and
 * the arrow keys move one active day that drives the tooltip; the same values
 * are always available through the table toggle.
 */
export function DailyBarChart({ title, days, series, format, axisFormat, summary, detail }: DailyBarChartProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const { ref, width } = useContainerWidth();
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric", timeZone: "UTC" }),
    [i18n.language],
  );
  const longDayFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "UTC" }),
    [i18n.language],
  );
  const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);

  const totals = days.map((d) => series.reduce((sum, s) => sum + s.value(d), 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const top = ticks[ticks.length - 1];
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const band = plotWidth / Math.max(1, days.length);
  const barWidth = band >= THIN_BAND ? Math.min(MAX_BAR, band * 0.72) : Math.max(1, band - (band > 2 ? 1 : 0));
  const baseline = MARGIN.top + PLOT_HEIGHT;
  const height = baseline + MARGIN.bottom;
  const yOf = (v: number) => baseline - (v / top) * PLOT_HEIGHT;
  const centerOf = (i: number) => MARGIN.left + i * band + band / 2;
  const labels = sampledLabels(days.length, band, LABEL_GAP_PX);

  const pickFromPointer = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left) / box.width) * days.length);
    setActive(Math.max(0, Math.min(days.length - 1, i)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = days.length - 1;
    const step: Record<string, (i: number) => number> = {
      ArrowLeft: (i) => Math.max(0, i - 1),
      ArrowRight: (i) => Math.min(last, i + 1),
      Home: () => 0,
      End: () => last,
    };
    const move = step[e.key];
    if (!move) return;
    e.preventDefault();
    setActive((i) => move(i ?? last));
  };

  const activeDay = active === null ? null : days[active];
  const tooltipLeft =
    active === null ? 0 : Math.max(0, Math.min(width - TOOLTIP_WIDTH, centerOf(active) - TOOLTIP_WIDTH / 2));

  return (
    <section aria-labelledby={headingId} className="rounded-md border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id={headingId} className="text-sm font-semibold text-text">
          {title}
        </h2>
        <div className="flex flex-wrap items-center gap-4">
          {series.length > 1 && (
            <ul className="flex items-center gap-4 text-xs text-muted">
              {series.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span className={`h-3 w-3 ${s.keyClass}`} aria-hidden="true" />
                  {s.label}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            aria-expanded={showTable}
            onClick={() => setShowTable((v) => !v)}
            className="min-h-touch rounded-sm px-2 text-xs font-medium text-accent hover:bg-surface-raised"
          >
            {showTable ? t("usage.chart.hideTable") : t("usage.chart.showTable")}
          </button>
        </div>
      </div>

      <div
        ref={ref}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys step through the days from here.
        tabIndex={0}
        role="group"
        aria-label={t("usage.chart.keyboard", { title })}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((i) => i ?? days.length - 1)}
        onBlur={() => setActive(null)}
        className="relative rounded-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={yOf(tick)}
                y2={yOf(tick)}
                className={tick === 0 ? "stroke-border" : "stroke-border-subtle"}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={MARGIN.left - 8}
                y={yOf(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-faint font-mono text-xs tabular-nums"
              >
                {axisFormat(tick)}
              </text>
            </g>
          ))}

          {active !== null && band < THIN_BAND && (
            <line
              x1={centerOf(active)}
              x2={centerOf(active)}
              y1={MARGIN.top}
              y2={baseline}
              className="stroke-muted"
              strokeWidth={1}
            />
          )}

          {days.map((day, i) => {
            const x = centerOf(i) - barWidth / 2;
            const heights = series.map((s) => (s.value(day) > 0 ? Math.max(1, (s.value(day) / top) * PLOT_HEIGHT) : 0));
            const topmost = heights.reduce((last, h, k) => (h > 0 ? k : last), -1);
            let stackTop = baseline;
            return (
              <g
                key={day.day}
                className={`transition-opacity duration-fast ${active !== null && active !== i ? "opacity-50" : ""}`}
              >
                {series.map((s, k) => {
                  const h = heights[k];
                  if (h === 0) return null;
                  // A segment sitting on another gives up its bottom 2px as a surface gap.
                  const gap = stackTop < baseline && h > SEGMENT_GAP ? SEGMENT_GAP : 0;
                  const y = stackTop - h;
                  stackTop = y;
                  return k === topmost ? (
                    <path key={s.key} d={topRoundedBar(x, y, barWidth, h - gap, BAR_RADIUS)} className={s.fillClass} />
                  ) : (
                    <rect key={s.key} x={x} y={y} width={barWidth} height={h - gap} className={s.fillClass} />
                  );
                })}
              </g>
            );
          })}

          {labels.map((i) => {
            const x = centerOf(i);
            const anchor = x < MARGIN.left + 28 ? "start" : x > width - 28 ? "end" : "middle";
            return (
              <text
                key={i}
                x={anchor === "start" ? MARGIN.left : anchor === "end" ? width - MARGIN.right : x}
                y={baseline + 16}
                textAnchor={anchor}
                className="fill-faint text-xs"
              >
                {dayFormat.format(dateOf(days[i].day))}
              </text>
            );
          })}

          {/* The whole plot is the hit target: the pointer snaps to the nearest day. */}
          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={plotWidth}
            height={PLOT_HEIGHT}
            fill="transparent"
            onPointerMove={pickFromPointer}
            onPointerDown={pickFromPointer}
            onPointerLeave={() => setActive(null)}
          />
        </svg>

        <div
          aria-live="polite"
          className={`pointer-events-none absolute top-0 rounded-sm border border-border bg-surface-raised px-3 py-2 shadow-2 ${activeDay ? "" : "sr-only"}`}
          style={{ left: tooltipLeft, width: TOOLTIP_WIDTH }}
        >
          {activeDay && (
            <>
              <div className="text-xs text-muted">{longDayFormat.format(dateOf(activeDay.day))}</div>
              <ul className="mt-1 space-y-1">
                {[...series].reverse().map((s) => (
                  <li key={s.key} className="flex items-center gap-2 text-xs">
                    <span className={`h-0.5 w-3 rounded-full ${s.keyClass}`} aria-hidden="true" />
                    <span className="font-mono text-sm font-semibold tabular-nums text-text">
                      {format(s.value(activeDay))}
                    </span>
                    <span className="text-muted">{s.label}</span>
                  </li>
                ))}
              </ul>
              {detail && <div className="mt-1 text-xs text-faint">{detail.describe(activeDay)}</div>}
            </>
          )}
        </div>
      </div>

      {showTable && (
        <div className="mt-3 max-h-80 overflow-y-auto rounded-sm border border-border-subtle">
          <table className="w-full text-xs">
            <caption className="sr-only">{title}</caption>
            <thead className="sticky top-0 bg-surface-raised text-left text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("usage.table.day")}
                </th>
                {series.map((s) => (
                  <th key={s.key} scope="col" className="px-3 py-2 text-right font-medium">
                    {s.label}
                  </th>
                ))}
                {detail && (
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {detail.label}
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums text-text">
              {[...days].reverse().map((day) => (
                <tr key={day.day} className="border-t border-border-subtle">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    {day.day}
                  </th>
                  {series.map((s) => (
                    <td key={s.key} className="px-3 py-2 text-right">
                      {format(s.value(day))}
                    </td>
                  ))}
                  {detail && <td className="px-3 py-2 text-right">{detail.value(day)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
