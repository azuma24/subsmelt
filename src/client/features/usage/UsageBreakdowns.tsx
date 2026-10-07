import { useId, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { formatCost, formatTokens } from "../../lib";
import type { UsageByKind, UsageByModel } from "../../types";

interface ShareRow {
  key: string;
  primary: ReactNode;
  meta: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** A titled list of rows, each with a share bar against the biggest row. */
function ShareList({ title, help, rows }: { title: string; help?: string; rows: ShareRow[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  const max = Math.max(1, ...rows.map((r) => r.inputTokens + r.outputTokens));
  return (
    <section aria-labelledby={headingId} className="rounded-md border border-border bg-surface p-4">
      <h2 id={headingId} className="text-sm font-semibold text-text">
        {title}
      </h2>
      {help && <p className="mt-1 text-xs leading-5 text-faint">{help}</p>}
      <ul className="mt-2">
        {rows.map((row) => {
          const total = row.inputTokens + row.outputTokens;
          return (
            <li key={row.key} className="border-b border-border-subtle py-3 last:border-b-0">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0 truncate text-sm font-medium text-text">{row.primary}</div>
                <div className="shrink-0 font-mono text-sm font-semibold tabular-nums text-text">
                  {formatTokens(total)}
                </div>
              </div>
              <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-faint">
                <span className="min-w-0 truncate">{row.meta}</span>
                <span className="font-mono tabular-nums">
                  {t("usage.inOut", { input: formatTokens(row.inputTokens), output: formatTokens(row.outputTokens) })}
                  {" · "}
                  {formatCost(row.costUsd)}
                </span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-highlight" aria-hidden="true">
                <div className="h-1 rounded-full bg-chart-1" style={{ width: `${(total / max) * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ByModelList({ rows }: { rows: UsageByModel[] }) {
  const { t } = useTranslation();
  return (
    <ShareList
      title={t("usage.byModel.title")}
      rows={rows.map((m) => ({
        key: `${m.provider}/${m.model}/${m.connectionLabel}`,
        primary: (
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-sm border border-border px-1 text-xs font-medium text-muted">
              {t(`settings.llmConnection.provider_${m.provider}`)}
            </span>
            <span className="truncate">{m.model}</span>
          </span>
        ),
        meta: `${m.connectionLabel} · ${t("usage.calls", { calls: m.calls.toLocaleString() })}`,
        ...m,
      }))}
    />
  );
}

export function ByKindList({ rows }: { rows: UsageByKind[] }) {
  const { t } = useTranslation();
  return (
    <ShareList
      title={t("usage.byKind.title")}
      help={t("usage.byKind.help")}
      rows={rows.map((k) => ({
        key: k.kind,
        primary: t(`usage.kind.${k.kind}`),
        meta: t("usage.calls", { calls: k.calls.toLocaleString() }),
        ...k,
      }))}
    />
  );
}
