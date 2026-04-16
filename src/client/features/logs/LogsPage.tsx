import { Fragment, useEffect, useRef, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useLogsQuery } from "../../hooks";
import { fullTime, highlightText, relativeTime } from "../../lib";
import type { LogEntry } from "../../types";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import { ActionButton } from "../../ui/primitives";

export function LogsPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const [params, setParams] = useSearchParams();
  const initialJobId = Number(params.get("job") || "");
  const [jobIdFilter, setJobIdFilter] = useState<number | null>(Number.isFinite(initialJobId) ? initialJobId : null);
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
    if (jobIdFilter) {
      setParams((prev) => {
        prev.set("job", String(jobIdFilter));
        return prev;
      });
    }
  }, [jobIdFilter, setParams]);

  const handleClear = async () => {
    const ok = await confirm({ title: t("logs.confirm.clearTitle"), message: t("logs.confirm.clearMessage"), confirmLabel: t("logs.confirm.clearConfirm"), danger: true });
    if (ok) {
      await api.clearLogsApi();
      addToast(t("logs.toast.cleared"), "info");
      logsQuery.refetch();
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-[1200px] flex-col space-y-4 p-4 md:p-6">
      <section className="rounded-3xl border border-gray-800 bg-gray-900/80 p-5 md:p-6">
        <div className={`flex ${isMobile ? "flex-col gap-4" : "items-center justify-between gap-4"}`}>
          <div>
            <h1 className="text-2xl font-semibold">{t("logs.title")}</h1>
            {jobIdFilter && <p className="mt-1 text-xs text-blue-300">{t("logs.filteredByJob", { id: jobIdFilter })}</p>}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-400"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-blue-500" />{t("logs.follow")}</label>
            <ActionButton variant="ghost" onClick={handleClear}>{t("logs.clear")}</ActionButton>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-gray-800 bg-gray-900/80 p-4">
        <div className={`flex ${isMobile ? "flex-col" : "items-center"} gap-3`}>
          <select value={level} onChange={(e) => setLevel(e.target.value)} className="rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-300"><option value="">{t("logs.level.all")}</option><option value="info">{t("logs.level.info")}</option><option value="warn">{t("logs.level.warn")}</option><option value="error">{t("logs.level.error")}</option></select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-300"><option value="">{t("logs.category.all")}</option><option value="scan">{t("logs.category.scan")}</option><option value="translate">{t("logs.category.translate")}</option><option value="queue">{t("logs.category.queue")}</option><option value="system">{t("logs.category.system")}</option></select>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("logs.search")} className="min-w-0 flex-1 rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200" />
          <input type="number" value={jobIdFilter || ""} onChange={(e) => setJobIdFilter(e.target.value ? Number(e.target.value) : null)} placeholder={t("logs.jobId")}
            className="w-28 rounded-2xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-200" />
          {jobIdFilter && (
            <button onClick={() => { setJobIdFilter(null); params.delete("job"); setParams(params); }} className="rounded-xl bg-gray-800 px-3 py-2 text-xs text-gray-300">
              {t("logs.clearJobFilter")}
            </button>
          )}
          <span className="shrink-0 text-xs text-gray-600">{search ? t("logs.entriesFiltered", { filtered: chronologicalLogs.length, total: logs.length }) : t("logs.entries", { count: chronologicalLogs.length })}</span>
        </div>
      </section>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto rounded-3xl border border-gray-800 bg-gray-900/80">
        {chronologicalLogs.length === 0 ? <div className="px-4 py-12 text-center text-sm text-gray-600">{search ? t("logs.noLogsSearch") : jobIdFilter ? t("logs.noLogsForJob") : t("logs.noLogs")}</div> : <div className="divide-y divide-gray-800/30">{chronologicalLogs.map((entry: LogEntry) => <LogRow key={entry.id} entry={entry} search={search} />)}</div>}
      </div>
    </div>
  );
}

function LogRow({ entry, search }: { entry: LogEntry; search: string }) {
  const { t } = useTranslation();
  const parts = search ? highlightText(entry.message, search) : [entry.message];
  return (
    <div className={`flex items-start gap-3 px-4 py-3 hover:bg-gray-800/20 ${entry.level === "error" ? "bg-red-950/10" : ""}`}>
      <div className={`mt-1 w-0.5 self-stretch rounded-full shrink-0 ${entry.level === "error" ? "bg-red-500" : entry.level === "warn" ? "bg-yellow-500" : "bg-gray-700"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="cursor-default font-mono text-[10px] text-gray-600" title={fullTime(entry.timestamp)}>{relativeTime(entry.timestamp)}</span>
          <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">{entry.category}</span>
          {entry.job_id && <NavLink to={`/jobs/${entry.job_id}`} className="text-[10px] text-blue-500/70 hover:text-blue-400">{t("logs.jobLink", { id: entry.job_id })}</NavLink>}
        </div>
        <p className={`mt-1 text-xs leading-relaxed ${entry.level === "error" ? "text-red-300" : entry.level === "warn" ? "text-yellow-300" : "text-gray-300"}`}>{parts.map((part, i) => search && part.toLowerCase() === search.toLowerCase() ? <mark key={i} className="rounded bg-yellow-500/30 px-0.5 text-yellow-200">{part}</mark> : <Fragment key={i}>{part}</Fragment>)}</p>
      </div>
    </div>
  );
}
