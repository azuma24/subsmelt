import { Fragment, useEffect, useRef, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useLogsQuery } from "../../hooks";
import { fullTime, highlightText, relativeTime } from "../../lib";
import type { LogEntry } from "../../types";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import { Accordion, RowActionsMenu } from "../../ui/primitives";

export function LogsPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const [params, setParams] = useSearchParams();
  const initialJobParam = params.get("job");
  const parsedInitialJobId = initialJobParam ? Number(initialJobParam) : NaN;
  const [jobIdFilter, setJobIdFilter] = useState<number | null>(
    Number.isInteger(parsedInitialJobId) && parsedInitialJobId > 0 ? parsedInitialJobId : null
  );
  const [level, setLevel] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const logsQuery = useLogsQuery(level, category, jobIdFilter);
  const logs = logsQuery.data || [];
  const chronologicalLogs = [...(search ? logs.filter((entry) => entry.message.toLowerCase().includes(search.toLowerCase()) || (entry.meta && entry.meta.toLowerCase().includes(search.toLowerCase()))) : logs)].reverse();

  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chronologicalLogs.length, follow]);

  useEffect(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (typeof jobIdFilter === "number" && Number.isInteger(jobIdFilter) && jobIdFilter > 0) {
        next.set("job", String(jobIdFilter));
      } else {
        next.delete("job");
      }
      return next;
    }, { replace: true });
  }, [jobIdFilter, setParams]);

  const handleClear = async () => {
    const ok = await confirm({ title: t("logs.confirm.clearTitle"), message: t("logs.confirm.clearMessage"), confirmLabel: t("logs.confirm.clearConfirm"), danger: true });
    if (ok) {
      await api.clearLogsApi();
      addToast(t("logs.toast.cleared"), "info");
      logsQuery.refetch();
    }
  };

  // L1 level quick-pill toggle
  const toggleLevel = (l: string) => {
    setLevel((prev) => (prev === l ? "" : l));
  };

  const hasFilters = Boolean(level || category || jobIdFilter);

  return (
    <div className="flex h-full flex-col">
      {/* L1 Topbar: title + search + follow + level quick-pills + overflow menu */}
      <div className={`sticky top-0 z-30 shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 md:px-[18px] ${isMobile ? "space-y-2" : ""}`}>
        {/* Row 1: title + follow + overflow menu */}
        <div className="flex min-h-[42px] items-center gap-2.5">
          <span className="text-sm font-semibold text-[var(--text)]">{t("logs.title")}</span>
          {jobIdFilter && <span className="text-[11px] text-[var(--accent)]">{t("logs.filteredByJob", { id: jobIdFilter })}</span>}
          <div className="ml-auto flex items-center gap-2.5">
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[var(--accent)]" />
              {t("logs.follow")}
            </label>
            {/* Clear → overflow menu (L3, destructive) */}
            <RowActionsMenu
              items={[
                { label: t("logs.clear"), danger: true, onClick: handleClear },
              ]}
            />
          </div>
        </div>
        {/* Row 2: search + level quick-pills */}
        <div className={`flex gap-2 ${isMobile ? "flex-col" : "flex-wrap items-center"}`}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("logs.search")}
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          {/* Level quick-pills */}
          <div className="flex gap-1.5">
            {(["error", "warn", "info"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => toggleLevel(l)}
                aria-pressed={level === l}
                className={`rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors ${
                  level === l
                    ? l === "error"
                      ? "border-[var(--red-border)] bg-[var(--red-dim)] text-[var(--red)]"
                      : l === "warn"
                        ? "border-[var(--yellow-border)] bg-[var(--yellow-dim)] text-[var(--yellow)]"
                        : "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]"
                    : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)]"
                }`}
              >
                {l === "error" ? t("logs.level.error") : l === "warn" ? t("logs.level.warn") : t("logs.level.info")}
              </button>
            ))}
          </div>
        </div>

        {/* L3: Filters accordion — category + job-id */}
        <Accordion title={t("logs.filters")} defaultOpen={hasFilters} className="mt-2 border-none bg-transparent p-0">
          <div className={`flex gap-2 pt-1 ${isMobile ? "flex-col" : "flex-wrap items-center"}`}>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text-2)] outline-none focus:border-[var(--accent)]"
            >
              <option value="">{t("logs.category.all")}</option>
              <option value="scan">{t("logs.category.scan")}</option>
              <option value="translate">{t("logs.category.translate")}</option>
              <option value="queue">{t("logs.category.queue")}</option>
              <option value="system">{t("logs.category.system")}</option>
            </select>
            <input
              type="number"
              value={jobIdFilter ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (!raw) { setJobIdFilter(null); return; }
                const next = Number(raw);
                setJobIdFilter(Number.isInteger(next) && next > 0 ? next : null);
              }}
              placeholder={t("logs.jobId")}
              className="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            {typeof jobIdFilter === "number" && jobIdFilter > 0 && (
              <button onClick={() => setJobIdFilter(null)} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-2)]">
                {t("logs.clearJobFilter")}
              </button>
            )}
          </div>
        </Accordion>

        {/* Entry count */}
        <div className="pb-1 text-xs text-[var(--text-3)]">
          {search ? t("logs.entriesFiltered", { filtered: chronologicalLogs.length, total: logs.length }) : t("logs.entries", { count: chronologicalLogs.length })}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3.5 py-2 md:px-[18px]">
        {chronologicalLogs.length === 0
          ? <div className="px-4 py-12 text-center text-[13px] text-[var(--text-3)]">{search ? t("logs.noLogsSearch") : jobIdFilter ? t("logs.noLogsForJob") : t("logs.noLogs")}</div>
          : <div>{chronologicalLogs.map((entry: LogEntry) => <LogRow key={entry.id} entry={entry} search={search} />)}</div>}
      </div>
    </div>
  );
}

const LEVEL_META: Record<string, { label: string; color: string }> = {
  info: { label: "INFO", color: "text-[var(--accent)]" },
  warn: { label: "WARN", color: "text-[var(--yellow)]" },
  error: { label: "ERR", color: "text-[var(--red)]" },
};

function LogRow({ entry, search }: { entry: LogEntry; search: string }) {
  const { t } = useTranslation();
  const parts = search ? highlightText(entry.message, search) : [entry.message];
  const meta = LEVEL_META[entry.level] || { label: entry.level.toUpperCase(), color: "text-[var(--text-2)]" };
  return (
    <div className="flex gap-2.5 border-b border-[var(--border-sub)] py-[7px] font-mono text-[12px]">
      <span className="w-[55px] shrink-0 cursor-default text-[var(--text-3)]" title={fullTime(entry.timestamp)}>{relativeTime(entry.timestamp)}</span>
      <span className={`w-[40px] shrink-0 font-semibold ${meta.color}`}>{meta.label}</span>
      <span className="w-[60px] shrink-0 truncate text-[var(--text-3)]">{entry.category}</span>
      <div className="min-w-0 flex-1">
        <span className={entry.level === "error" ? "text-[var(--red)]" : entry.level === "warn" ? "text-[var(--yellow)]" : "text-[var(--text-2)]"}>{parts.map((part, i) => search && part.toLowerCase() === search.toLowerCase() ? <mark key={i} className="rounded bg-[var(--yellow-dim)] px-0.5 text-[var(--yellow)]">{part}</mark> : <Fragment key={i}>{part}</Fragment>)}</span>
        {entry.job_id && <NavLink to={`/jobs/${entry.job_id}`} className="ml-2 text-[var(--accent)]/70 hover:text-[var(--accent)]">{t("logs.jobLink", { id: entry.job_id })}</NavLink>}
      </div>
    </div>
  );
}
