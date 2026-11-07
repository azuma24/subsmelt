import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useIsMobile } from "../../hooks";
import { useTranslation } from "../../i18n";
import { formatCost, formatTokens, fullTime, relativeTime } from "../../lib";
import type { UsageCall, UsageFile } from "../../types";
import { ActionButton } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { selectCls } from "../../ui/SortControls";
import { nextSort, type SortDir, type SortValue, sortRows, type TableSort } from "./table-sort";

interface SortColumn<Row> {
  key: string;
  label: string;
  numeric?: boolean;
  sortValue: (row: Row) => SortValue;
}

interface Column<Row> extends SortColumn<Row> {
  cell: (row: Row) => ReactNode;
}

interface UsageTableProps<Row> {
  title: string;
  rows: Row[];
  rowKey: (row: Row, index: number) => string;
  columns: Column<Row>[];
  defaultSort: TableSort;
  /** Phone layout: the row's main line and its muted metadata. */
  primary: (row: Row) => ReactNode;
  meta: (row: Row) => string;
}

const firstDir = (column: { numeric?: boolean }): SortDir => (column.numeric ? "desc" : "asc");
const dirIcon = (dir: SortDir) => (dir === "asc" ? "arrow-up" : "arrow-down");

function useUsageSort<Row>(columns: SortColumn<Row>[], defaultSort: TableSort) {
  const [sort, setSort] = useState(defaultSort);
  const active = columns.find((c) => c.key === sort.key) ?? columns[0];
  const sortBy = (key: string) => {
    const column = columns.find((c) => c.key === key) ?? active;
    setSort((current) => nextSort(current, column.key, firstDir(column)));
  };
  return { active, dir: sort.dir, sortBy };
}

function UsageSortControls({
  columns,
  column,
  dir,
  sortBy,
  label,
}: {
  columns: Pick<SortColumn<unknown>, "key" | "label">[];
  column: string;
  dir: SortDir;
  sortBy: (key: string) => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      <select aria-label={label} value={column} onChange={(event) => sortBy(event.target.value)} className={selectCls}>
        {columns.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      <ActionButton variant="ghost" size="sm" onClick={() => sortBy(column)}>
        <Icon name={dirIcon(dir)} />
        <span className="sr-only">{dir === "asc" ? t("whisper.sortAsc") : t("whisper.sortDesc")}</span>
      </ActionButton>
    </div>
  );
}

/** A real table on wide screens, stacked rows on phones; both sort by any column. */
function UsageTable<Row>({ title, rows, rowKey, columns, defaultSort, primary, meta }: UsageTableProps<Row>) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const headingId = useId();
  const { active, dir, sortBy } = useUsageSort(columns, defaultSort);
  const sorted = sortRows(rows, active.sortValue, dir);
  return (
    <section aria-labelledby={headingId} className="rounded-md border border-border bg-surface p-4">
      <h2 id={headingId} className="text-sm font-semibold text-text">
        {title}
      </h2>
      {isMobile ? (
        <>
          <div className="mt-2">
            <UsageSortControls
              columns={columns}
              column={active.key}
              dir={dir}
              sortBy={sortBy}
              label={t("whisper.sortAriaLabel")}
            />
          </div>
          <ul className="mt-2">
            {sorted.map((row, i) => (
              <li key={rowKey(row, i)} className="border-b border-border-subtle py-3 last:border-b-0">
                <div className="truncate text-sm text-text">{primary(row)}</div>
                <div className="mt-1 font-mono text-xs tabular-nums text-faint">{meta(row)}</div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm" aria-labelledby={headingId}>
            <thead className="text-left text-xs text-muted">
              <tr>
                {columns.map((c) => {
                  const isActive = c.key === active.key;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={isActive ? (dir === "asc" ? "ascending" : "descending") : undefined}
                      className="p-0 font-medium"
                    >
                      <button
                        type="button"
                        onClick={() => sortBy(c.key)}
                        className={`flex w-full items-center gap-1 rounded-sm px-2 py-2 font-medium transition-colors hover:text-text ${c.numeric ? "justify-end" : ""} ${isActive ? "text-text" : ""}`}
                      >
                        {c.numeric && isActive && <Icon name={dirIcon(dir)} size={16} />}
                        {c.label}
                        {!c.numeric && isActive && <Icon name={dirIcon(dir)} size={16} />}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <tr key={rowKey(row, i)} className="border-t border-border-subtle">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-2 py-2 ${c.numeric ? "text-right font-mono tabular-nums text-muted" : "max-w-xs truncate text-text"}`}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FileName({ jobId, name }: { jobId: number | null; name: string | null }) {
  const { t } = useTranslation();
  const label = name ?? t("usage.noFile");
  return jobId === null ? (
    <span title={label}>{label}</span>
  ) : (
    <Link to={`/jobs/${jobId}`} title={label} className="text-text hover:text-accent hover:underline">
      {label}
    </Link>
  );
}

export function TopFilesTable({ rows }: { rows: UsageFile[] }) {
  const { t } = useTranslation();
  return (
    <UsageTable
      title={t("usage.topFiles.title")}
      rows={rows}
      defaultSort={{ key: "tokens", dir: "desc" }}
      rowKey={(f) => `${f.jobId ?? "convert"}/${f.srtName}`}
      primary={(f) => <FileName jobId={f.jobId} name={f.srtName} />}
      meta={(f) =>
        [
          t("usage.calls", { calls: f.calls.toLocaleString() }),
          t("usage.inOut", { input: formatTokens(f.inputTokens), output: formatTokens(f.outputTokens) }),
          formatCost(f.costUsd),
        ].join(" · ")
      }
      columns={[
        {
          key: "file",
          label: t("usage.table.file"),
          cell: (f) => <FileName jobId={f.jobId} name={f.srtName} />,
          sortValue: (f) => f.srtName,
        },
        {
          key: "calls",
          label: t("usage.table.calls"),
          numeric: true,
          cell: (f) => f.calls.toLocaleString(),
          sortValue: (f) => f.calls,
        },
        {
          key: "in",
          label: t("usage.table.input"),
          numeric: true,
          cell: (f) => formatTokens(f.inputTokens),
          sortValue: (f) => f.inputTokens,
        },
        {
          key: "out",
          label: t("usage.table.output"),
          numeric: true,
          cell: (f) => formatTokens(f.outputTokens),
          sortValue: (f) => f.outputTokens,
        },
        {
          key: "tokens",
          label: t("usage.stat.total"),
          numeric: true,
          cell: (f) => formatTokens(f.inputTokens + f.outputTokens),
          sortValue: (f) => f.inputTokens + f.outputTokens,
        },
        {
          key: "cost",
          label: t("usage.table.cost"),
          numeric: true,
          cell: (f) => formatCost(f.costUsd),
          sortValue: (f) => f.costUsd,
        },
      ]}
    />
  );
}

export function RecentCalls({ rows }: { rows: UsageCall[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  const columns: SortColumn<UsageCall>[] = [
    { key: "time", label: t("usage.table.time"), sortValue: (c) => c.ts },
    { key: "file", label: t("usage.table.file"), sortValue: (c) => c.srtName },
    { key: "kind", label: t("usage.table.kind"), sortValue: (c) => t(`usage.kind.${c.kind}`) },
    { key: "model", label: t("usage.table.model"), sortValue: (c) => c.model },
    { key: "in", label: t("usage.table.input"), numeric: true, sortValue: (c) => c.inputTokens },
    { key: "out", label: t("usage.table.output"), numeric: true, sortValue: (c) => c.outputTokens },
    { key: "cost", label: t("usage.table.cost"), numeric: true, sortValue: (c) => c.costUsd },
  ];
  const { active, dir, sortBy } = useUsageSort(columns, { key: "time", dir: "desc" });
  // Keep open rows attached to the same call when sorting or receiving new calls.
  const duplicates = new Map<string, number>();
  const keyed = rows.map((call) => {
    const identity = JSON.stringify([
      call.ts,
      call.jobId,
      call.srtName,
      call.kind,
      call.model,
      call.inputTokens,
      call.outputTokens,
      call.costUsd,
    ]);
    const occurrence = duplicates.get(identity) ?? 0;
    duplicates.set(identity, occurrence + 1);
    return { call, key: `${identity}/${occurrence}` };
  });
  const sorted = sortRows(keyed, ({ call }) => active.sortValue(call), dir);

  return (
    <section aria-labelledby={headingId} className="@container rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold text-text">
          {t("usage.recent.title")}
        </h2>
        <UsageSortControls
          columns={columns}
          column={active.key}
          dir={dir}
          sortBy={sortBy}
          label={t("usage.recent.sort")}
        />
      </div>
      <ul className="mt-2 divide-y divide-border-subtle">
        {sorted.map(({ call, key }) => (
          <li key={key}>
            <details className="group">
              <summary className="flex min-h-touch cursor-pointer list-none items-center gap-2 rounded-sm px-1 py-1.5 text-sm hover:bg-surface-raised md:min-h-8 [&::-webkit-details-marker]:hidden">
                <time dateTime={call.ts} className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted">
                  {relativeTime(call.ts)}
                </time>
                <span className="min-w-0 flex-1 truncate text-text" title={call.srtName ?? undefined}>
                  {call.srtName ?? t("usage.noFile")}
                </span>
                <span className="hidden max-w-1/4 truncate font-mono text-xs text-muted @lg:block">{call.model}</span>
                <Icon
                  name="chevron-down"
                  size={16}
                  className="shrink-0 text-muted transition-transform group-open:rotate-180"
                />
              </summary>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-1 pb-3 pt-2 text-xs @lg:grid-cols-3">
                <div className="col-span-full">
                  <dt className="text-muted">{t("usage.table.file")}</dt>
                  <dd className="mt-0.5 [overflow-wrap:anywhere]">
                    <FileName jobId={call.jobId} name={call.srtName} />
                  </dd>
                </div>
                {[
                  ["time", fullTime(call.ts)],
                  ["kind", t(`usage.kind.${call.kind}`)],
                  ["model", call.model],
                  ["input", call.inputTokens.toLocaleString()],
                  ["output", call.outputTokens.toLocaleString()],
                  ["cost", formatCost(call.costUsd)],
                ].map(([key, value]) => (
                  <div key={key} className="min-w-0">
                    <dt className="text-muted">{t(`usage.table.${key}`)}</dt>
                    <dd className="mt-0.5 tabular-nums text-text [overflow-wrap:anywhere]">{value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
