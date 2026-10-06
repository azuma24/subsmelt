import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import type { UseQueryResult } from "@tanstack/react-query";
import type { TranscriptionLogs } from "../../api";
import { highlightText } from "../../lib";
import { ActionButton, EmptyHint } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { useIsMobile } from "../../hooks";
import { Icon } from "../../ui/Icon";

interface BackendLogViewProps {
  query: UseQueryResult<TranscriptionLogs>;
  follow: boolean;
}

/**
 * The Whisper backend's own log, tailed over HTTP.
 *
 * This is a different source from the app's log store, not another category of
 * it: the backend writes a plain text file on its own host, which for a Windows
 * service or the GUI's console-less child process was previously unreadable
 * without sitting at the machine. It arrives as unstructured lines, so there is
 * no level or category filter here — only search.
 *
 * "Logging is off" is a first-class state, not an error. The backend never fails
 * startup over a log path it cannot open, so the honest thing to show is the
 * reason it reports rather than an empty pane.
 */
export function BackendLogView({ query, follow }: BackendLogViewProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const data = query.data;

  const lines = useMemo(() => {
    const all = data?.lines ?? [];
    if (!search) return all;
    const needle = search.toLowerCase();
    return all.filter((line) => line.toLowerCase().includes(needle));
  }, [data?.lines, search]);

  // Tail behaviour: stick to the bottom while following, matching the app log.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scrolls when the lines change
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const unreachable = data && data.ok === false;
  // Any error the backend reports on a successful proxy response, whether or
  // not the handler is still attached. `active: true` with an error is a real
  // combination — the file was deleted or replaced under a live handler — and
  // gating on `active === false` would hide the reason behind "no log output".
  const reachable = Boolean(data) && data?.ok !== false;
  const loggingOff = reachable && data?.active === false;
  const readProblem = reachable && Boolean(data?.error);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={`flex gap-2 border-b border-border px-4 py-2 md:px-4 ${isMobile ? "flex-col" : "flex-wrap items-center"}`}
      >
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("logs.search")}
          aria-label={t("logs.search")}
          className="min-w-0 flex-1 rounded-sm border border-border bg-surface-raised px-3 py-2 text-sm text-text focus:border-accent"
        />
        <ActionButton variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? t("common.loading") : t("logs.backend.refresh")}
        </ActionButton>
      </div>

      {/* Where the file lives, so a reader knows what they're looking at and
          where to find it on the host. */}
      {data?.file && (
        <div className="px-4 pt-2 text-xs text-faint md:px-4">
          <span className="font-mono break-all">{data.file}</span>
          {data.truncated && <span> · {t("logs.backend.truncated")}</span>}
        </div>
      )}

      {query.isError && (
        <div className="px-4 pt-2 md:px-4">
          <InlineError onRetry={() => void query.refetch()} />
        </div>
      )}

      {unreachable && (
        <div className="px-4 pt-2 md:px-4">
          <div
            role="status"
            className="rounded-md border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning"
          >
            <Icon name="warning" />
            {data?.reason === "endpoint-missing"
              ? t("logs.backend.notConfigured")
              : t("logs.backend.unreachable", { message: data?.message || "" })}
          </div>
        </div>
      )}

      {(loggingOff || readProblem) && (
        <div className="px-4 pt-2 md:px-4">
          <div
            role="status"
            className="rounded-md border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning"
          >
            <Icon name="warning" />
            {loggingOff ? t("logs.backend.loggingOff") : t("logs.backend.readFailed")}
            {data?.error && <span className="block font-mono text-xs opacity-90">{data.error}</span>}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-2 md:px-4">
        {lines.length === 0 ? (
          <EmptyHint text={search ? t("logs.noLogsSearch") : t("logs.backend.empty")} />
        ) : (
          <div className="font-mono text-xs leading-relaxed text-muted">
            {lines.map((line, i) => (
              <div
                key={`${i}-${line.slice(0, 24)}`}
                className="whitespace-pre-wrap break-all border-b border-border-subtle py-1"
              >
                {search ? highlightText(line, search) : line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
