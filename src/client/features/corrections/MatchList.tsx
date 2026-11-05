import { useTranslation } from "../../i18n";
import type { ScanMatch, ScanReport } from "../../../shared/corrections";

/** Matches that can be ticked: a file that cannot be rewritten is shown but not offered. */
export const fixable = (match: ScanMatch) => !match.error;

/**
 * The files a dry run found, each with its count and up to two sample lines,
 * ticked for fixing. Unticking a file leaves it alone this time only.
 */
export function MatchList({
  report,
  selected,
  onChange,
}: {
  report: ScanReport;
  selected: ReadonlySet<string>;
  onChange: (selected: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const toggle = (path: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(path);
    else next.delete(path);
    onChange(next);
  };
  if (report.matches.length === 0) {
    return <p className="text-xs text-muted">{t("corrections.fix.noMatches", { count: report.filesScanned })}</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="flex-1">
          {t("corrections.fix.found", { matches: report.totalMatches, count: report.matches.length })}
        </span>
        <button
          type="button"
          onClick={() => onChange(new Set(report.matches.filter(fixable).map((m) => m.path)))}
          className="rounded-sm px-2 py-1 hover:text-text"
        >
          {t("corrections.fix.selectAll")}
        </button>
        <button type="button" onClick={() => onChange(new Set())} className="rounded-sm px-2 py-1 hover:text-text">
          {t("corrections.fix.selectNone")}
        </button>
      </div>
      <ul className="max-h-[40vh] divide-y divide-border-subtle overflow-y-auto rounded-sm border border-border bg-surface">
        {report.matches.map((match) => (
          <li key={match.path} className="px-3 py-2">
            <label className={`flex items-start gap-2 ${fixable(match) ? "cursor-pointer" : "opacity-60"}`}>
              <input
                type="checkbox"
                checked={selected.has(match.path)}
                disabled={!fixable(match)}
                onChange={(e) => toggle(match.path, e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-accent"
              />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="min-w-0 break-words font-medium text-text [overflow-wrap:anywhere]">
                    {match.relative}
                  </span>
                  <span className="text-xs text-faint">
                    {t("corrections.fix.matchCount", { count: match.count })}
                    {match.kind === "output" && ` · ${t("corrections.fix.translation")}`}
                  </span>
                </span>
                {match.samples.map((sample) => (
                  <span key={sample.before} className="block font-mono text-[11px] leading-5 text-muted">
                    <span className="line-through decoration-danger/60">{sample.before}</span>
                    <br />
                    <span className="text-text">{sample.after}</span>
                  </span>
                ))}
                {match.error && <span className="block text-xs text-danger">{match.error}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {report.truncated && (
        <p className="text-xs text-warning">{t("corrections.fix.truncated", { count: report.filesScanned })}</p>
      )}
    </div>
  );
}
