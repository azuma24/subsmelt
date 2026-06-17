import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as api from "../../api";
import { useLogsQuery } from "../../hooks";
import { fullTime, highlightText, relativeTime } from "../../lib";
import type { LogEntry } from "../../types";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import { Accordion, RowActionsMenu } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";

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
  const logsQuery = useLogsQuery(level, category, jobIdFilter);
  const logs = logsQuery.data || [];
  // Filter (by search) then reverse to chronological order. Memoized so typing
  // in an unrelated field or an SSE-driven re-render doesn't re-filter/re-copy
  // the (up to 300) log entries on every render — only `logs`/`search` matter.
  const chronologicalLogs = useMemo(
    () => [...(search ? logs.filter((entry) => entry.message.toLowerCase().includes(search.toLowerCase()) || (entry.meta && entry.meta.toLowerCase().includes(search.toLowerCase()))) : logs)].reverse(),
    [logs, search]
  );

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
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("logs.search")}
            aria-label={t("logs.search")}
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
              aria-label={t("logs.category.all")}
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
              aria-label={t("logs.jobId")}
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

      {logsQuery.isError && (
        <div className="px-3.5 pt-2 md:px-[18px]">
          <InlineError onRetry={() => void logsQuery.refetch()} />
        </div>
      )}

      {chronologicalLogs.length === 0 ? (
        <div className="flex-1 overflow-y-auto px-3.5 py-2 md:px-[18px]">
          <div className="px-4 py-12 text-center text-[13px] text-[var(--text-3)]">{search ? t("logs.noLogsSearch") : jobIdFilter ? t("logs.noLogsForJob") : t("logs.noLogs")}</div>
        </div>
      ) : (
        <LogList logs={chronologicalLogs} search={search} follow={follow} />
      )}
    </div>
  );
}

// Above this many entries we window the list (only rows near the viewport are
// mounted). Below it we render everything so small log views stay simple and
// fully rendered, which also avoids virtualization edge cases at low counts.
const VIRTUALIZE_THRESHOLD = 200;
// Initial per-row height guess. Log rows are variable height because long
// messages wrap onto multiple lines, so this is only a starting estimate —
// `virtualizer.measureElement` remeasures each mounted row's true height.
const ROW_ESTIMATE = 28;

// Picks the plain or windowed renderer by entry count. Splitting into two
// components (mirroring JobsTableDesktop's VirtualJobRows pattern) means the
// non-virtual path never instantiates `useVirtualizer` and never runs the
// virtualizer-driven scroll effect — those costs only exist above the
// threshold. Both paths share the same `LogRow` markup so behavior/styling and
// the follow-mode auto-scroll stay identical to the original single-component.
function LogList({ logs, search, follow }: { logs: LogEntry[]; search: string; follow: boolean }) {
  return logs.length > VIRTUALIZE_THRESHOLD ? (
    <VirtualLogList logs={logs} search={search} follow={follow} />
  ) : (
    <PlainLogList logs={logs} search={search} follow={follow} />
  );
}

// Non-windowed list: renders every row. Auto-scroll (follow mode) sets the
// container's scrollTop to the bottom directly. No virtualizer is created here.
function PlainLogList({ logs, search, follow }: { logs: LogEntry[]; search: string; follow: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Newest entries are at the end (chronological order). Re-run when new entries
  // arrive (length changes) or follow toggles on, matching the original.
  useEffect(() => {
    if (!follow) return;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs.length, follow]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-3.5 py-2 md:px-[18px]">
      <div>
        {logs.map((entry) => (
          <LogRow key={entry.id} entry={entry} search={search} />
        ))}
      </div>
    </div>
  );
}

// Windowed list: only rows near the viewport are mounted. Auto-scroll (follow
// mode) drives the virtualizer to the last index.
function VirtualLogList({ logs, search, follow }: { logs: LogEntry[]; search: string; follow: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 16,
    // Stable key per entry so dynamic measurements stay attached to the right
    // log across re-renders (filtering/new entries), independent of index.
    getItemKey: (index) => logs[index].id,
  });

  // Auto-scroll-to-latest (follow mode). Re-run when new entries arrive (length
  // changes) or follow toggles on.
  useEffect(() => {
    if (!follow) return;
    if (logs.length > 0) virtualizer.scrollToIndex(logs.length - 1, { align: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs.length, follow]);

  return (
    <div
      ref={scrollRef}
      // Bounded scroll viewport for the windowed rows. `scrollbarGutter: stable`
      // reserves the scrollbar track so row width stays constant as the windowed
      // content changes height.
      className="flex-1 overflow-y-auto px-3.5 py-2 md:px-[18px]"
      style={{ scrollbarGutter: "stable" }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((vitem) => {
          const entry = logs[vitem.index];
          return (
            <div
              key={entry.id}
              data-index={vitem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vitem.start}px)`,
              }}
            >
              <LogRow entry={entry} search={search} />
            </div>
          );
        })}
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
