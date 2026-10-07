import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useIsMobile } from "../../hooks";
import { useTranslation } from "../../i18n";
import { formatCost, formatTokens, fullTime, relativeTime } from "../../lib";
import type { UsageCall, UsageFile } from "../../types";

interface Column<Row> {
  key: string;
  label: string;
  numeric?: boolean;
  cell: (row: Row) => ReactNode;
}

interface UsageTableProps<Row> {
  title: string;
  rows: Row[];
  rowKey: (row: Row, index: number) => string;
  columns: Column<Row>[];
  /** Phone layout: the row's main line and its muted metadata. */
  primary: (row: Row) => ReactNode;
  meta: (row: Row) => string;
}

/** A real table on wide screens, stacked rows on phones. */
function UsageTable<Row>({ title, rows, rowKey, columns, primary, meta }: UsageTableProps<Row>) {
  const isMobile = useIsMobile();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="rounded-md border border-border bg-surface p-4">
      <h2 id={headingId} className="text-sm font-semibold text-text">
        {title}
      </h2>
      {isMobile ? (
        <ul className="mt-2">
          {rows.map((row, i) => (
            <li key={rowKey(row, i)} className="border-b border-border-subtle py-3 last:border-b-0">
              <div className="truncate text-sm text-text">{primary(row)}</div>
              <div className="mt-1 font-mono text-xs tabular-nums text-faint">{meta(row)}</div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm" aria-labelledby={headingId}>
            <thead className="text-left text-xs text-muted">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className={`px-2 py-2 font-medium ${c.numeric ? "text-right" : ""}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
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
        { key: "file", label: t("usage.table.file"), cell: (f) => <FileName jobId={f.jobId} name={f.srtName} /> },
        { key: "calls", label: t("usage.table.calls"), numeric: true, cell: (f) => f.calls.toLocaleString() },
        { key: "in", label: t("usage.table.input"), numeric: true, cell: (f) => formatTokens(f.inputTokens) },
        { key: "out", label: t("usage.table.output"), numeric: true, cell: (f) => formatTokens(f.outputTokens) },
        { key: "cost", label: t("usage.table.cost"), numeric: true, cell: (f) => formatCost(f.costUsd) },
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
        { key: "time", label: t("usage.table.time"), cell: when },
        { key: "file", label: t("usage.table.file"), cell: (c) => <FileName jobId={c.jobId} name={c.srtName} /> },
        { key: "kind", label: t("usage.table.kind"), cell: (c) => t(`usage.kind.${c.kind}`) },
        { key: "model", label: t("usage.table.model"), cell: (c) => c.model },
        { key: "in", label: t("usage.table.input"), numeric: true, cell: (c) => formatTokens(c.inputTokens) },
        { key: "out", label: t("usage.table.output"), numeric: true, cell: (c) => formatTokens(c.outputTokens) },
        { key: "cost", label: t("usage.table.cost"), numeric: true, cell: (c) => formatCost(c.costUsd) },
      ]}
    />
  );
}
