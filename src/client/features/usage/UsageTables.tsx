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

interface Column<Row> {
  key: string;
  label: string;
  numeric?: boolean;
  cell: (row: Row) => ReactNode;
  sortValue: (row: Row) => SortValue;
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

/** A real table on wide screens, stacked rows on phones; both sort by any column. */
function UsageTable<Row>({ title, rows, rowKey, columns, defaultSort, primary, meta }: UsageTableProps<Row>) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const headingId = useId();
  const [sort, setSort] = useState(defaultSort);
  const active = columns.find((c) => c.key === sort.key) ?? columns[0];
  const sorted = sortRows(rows, active.sortValue, sort.dir);
  const sortBy = (key: string) => {
    const column = columns.find((c) => c.key === key) ?? active;
    setSort((current) => nextSort(current, column.key, firstDir(column)));
  };
  return (
    <section aria-labelledby={headingId} className="rounded-md border border-border bg-surface p-4">
      <h2 id={headingId} className="text-sm font-semibold text-text">
        {title}
      </h2>
      {isMobile ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            <select
              aria-label={t("whisper.sortAriaLabel")}
              value={active.key}
              onChange={(event) => sortBy(event.target.value)}
              className={selectCls}
            >
              {columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <ActionButton variant="ghost" size="sm" onClick={() => sortBy(active.key)}>
              <Icon name={dirIcon(sort.dir)} />
              <span className="sr-only">{sort.dir === "asc" ? t("whisper.sortAsc") : t("whisper.sortDesc")}</span>
            </ActionButton>
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
                      aria-sort={isActive ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                      className="p-0 font-medium"
                    >
                      <button
                        type="button"
                        onClick={() => sortBy(c.key)}
                        className={`flex w-full items-center gap-1 rounded-sm px-2 py-2 font-medium transition-colors hover:text-text ${c.numeric ? "justify-end" : ""} ${isActive ? "text-text" : ""}`}
                      >
                        {c.numeric && isActive && <Icon name={dirIcon(sort.dir)} size={16} />}
                        {c.label}
                        {!c.numeric && isActive && <Icon name={dirIcon(sort.dir)} size={16} />}
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

export function RecentCallsTable({ rows }: { rows: UsageCall[] }) {
  const { t } = useTranslation();
  const when = (c: UsageCall) => <time title={fullTime(c.ts)}>{relativeTime(c.ts)}</time>;
  return (
    <UsageTable
      title={t("usage.recent.title")}
      rows={rows}
      defaultSort={{ key: "time", dir: "desc" }}
      rowKey={(c, i) => `${c.ts}/${i}`}
      primary={(c) => <FileName jobId={c.jobId} name={c.srtName} />}
      meta={(c) =>
        [
          relativeTime(c.ts),
          t(`usage.kind.${c.kind}`),
          c.model,
          t("usage.inOut", { input: formatTokens(c.inputTokens), output: formatTokens(c.outputTokens) }),
          formatCost(c.costUsd),
        ].join(" · ")
      }
      columns={[
        { key: "time", label: t("usage.table.time"), cell: when, sortValue: (c) => c.ts },
        {
          key: "file",
          label: t("usage.table.file"),
          cell: (c) => <FileName jobId={c.jobId} name={c.srtName} />,
          sortValue: (c) => c.srtName,
        },
        {
          key: "kind",
          label: t("usage.table.kind"),
          cell: (c) => t(`usage.kind.${c.kind}`),
          sortValue: (c) => t(`usage.kind.${c.kind}`),
        },
        { key: "model", label: t("usage.table.model"), cell: (c) => c.model, sortValue: (c) => c.model },
        {
          key: "in",
          label: t("usage.table.input"),
          numeric: true,
          cell: (c) => formatTokens(c.inputTokens),
          sortValue: (c) => c.inputTokens,
        },
        {
          key: "out",
          label: t("usage.table.output"),
          numeric: true,
          cell: (c) => formatTokens(c.outputTokens),
          sortValue: (c) => c.outputTokens,
        },
        {
          key: "cost",
          label: t("usage.table.cost"),
          numeric: true,
          cell: (c) => formatCost(c.costUsd),
          sortValue: (c) => c.costUsd,
        },
      ]}
    />
  );
}
