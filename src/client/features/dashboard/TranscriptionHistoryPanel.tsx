import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptionHistoryEntry } from "../../types";
import { groupTranscriptionAttempts, retryableGroups, type TranscriptionGroup } from "./transcription-groups";
import { classifyError, errorHintKeys } from "../../lib/errorTaxonomy";
import { fullTime, relativeTime } from "../../lib";

interface TranscriptionHistoryPanelProps {
  attempts: TranscriptionHistoryEntry[];
  transcribingPath: string | null;
  isRetryPending: boolean;
  isTranscribePending: boolean;
  onRetry: (attempt: TranscriptionHistoryEntry) => void;
  /** Omit to hide the clear/remove controls (read-only panel). */
  onClear?: () => void;
  onRemove?: (attempt: TranscriptionHistoryEntry) => void;
  /** Omit to hide the bulk retry action. Receives the latest attempt per failed file. */
  onRetryAllFailed?: (attempts: TranscriptionHistoryEntry[]) => void;
  isClearPending?: boolean;
  /** Id of the entry currently being removed, so only its button shows pending. */
  removingId?: string | null;
}

function statusClasses(status: string): string {
  if (status === "succeeded") return "border-success-line bg-success-soft text-success";
  if (status === "failed") return "border-danger-line bg-danger-soft text-danger";
  return "border-accent-line bg-accent-soft text-accent";
}

export function TranscriptionHistoryPanel({
  attempts,
  transcribingPath,
  isRetryPending,
  isTranscribePending,
  onRetry,
  onClear,
  onRemove,
  onRetryAllFailed,
  isClearPending = false,
  removingId = null,
}: TranscriptionHistoryPanelProps) {
  const { t } = useTranslation();
  // One row per file: a file that failed repeatedly used to render as N
  // near-identical rows, each needing its own Retry click.
  const groups = useMemo(() => groupTranscriptionAttempts(attempts), [attempts]);
  const failed = useMemo(() => retryableGroups(groups), [groups]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The server also emits "cancelled", which the client type does not list yet;
  // an unknown status falls back to the raw value rather than a key path.
  const statusLabel = (status: string) => t(`transcriptionHistory.status.${status}`, { defaultValue: status });

  const toggle = (inputPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(inputPath)) next.delete(inputPath);
      else next.add(inputPath);
      return next;
    });
  };

  // Running attempts are never cleared server-side, so the button is only useful
  // while at least one finished entry is listed.
  const clearableCount = attempts.filter((attempt) => attempt.status !== "running").length;

  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">{t("transcriptionHistory.title")}</h2>
          <p className="text-xs text-faint">{t("transcriptionHistory.description")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="whitespace-nowrap text-xs text-faint">{t("transcriptionHistory.shown", { count: groups.length })}</span>
          {onRetryAllFailed && failed.length > 0 && (
            <button
              type="button"
              onClick={() => onRetryAllFailed(failed.map((group) => group.latest))}
              disabled={isRetryPending || isTranscribePending}
              className="rounded-sm border border-danger-line bg-danger-soft px-3 py-2 text-xs font-medium text-danger disabled:opacity-40"
            >
              {t("transcriptionHistory.retryAllFailed", { count: failed.length })}
            </button>
          )}
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              disabled={isClearPending || clearableCount === 0}
              className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-xs font-medium text-text disabled:opacity-40 min-h-touch md:min-h-0"
            >
              {isClearPending ? t("transcriptionHistory.clearing") : t("transcriptionHistory.clear")}
            </button>
          )}
        </div>
      </div>
      {groups.length === 0 ? (
        <div className="text-sm text-faint">{t("transcriptionHistory.empty")}</div>
      ) : (
        <div className="space-y-2">
          {groups.map((group: TranscriptionGroup) => {
            const { latest } = group;
            const activeRetry = transcribingPath === group.inputPath && isRetryPending;
            const isExpanded = expanded.has(group.inputPath);
            const hasHistory = group.attempts.length > 1;
            return (
              <div key={group.inputPath} className="rounded-sm border border-border bg-surface-raised p-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-text">{group.title}</div>
                    <div className="mt-1 text-xs text-faint">
                      {latest.model} • {latest.language} • {latest.outputFormat.toUpperCase()} • {latest.postAction === "transcribe_and_translate" ? t("transcriptionHistory.postQueueTranslate") : t("transcriptionHistory.postTranscribeOnly")}
                    </div>
                    {latest.status === "failed" ? (
                      (() => {
                        const hint = errorHintKeys(classifyError(latest.errorSummary));
                        return (
                          <>
                            <div className="mt-1 text-xs text-muted">
                              {hint ? t(hint) : latest.errorSummary || t("transcriptionHistory.failedFallback")}
                            </div>
                            {/* The raw text is rendered, not just a title tooltip:
                                tooltips are unreachable on touch and cannot be
                                selected, and this is what a bug report needs. */}
                            {hint && latest.errorSummary && (
                              <div className="mt-1 select-all break-words font-mono text-xs text-faint">
                                {latest.errorSummary}
                              </div>
                            )}
                          </>
                        );
                      })()
                    ) : (
                      <div className="mt-1 text-xs text-faint" title={fullTime(latest.finishedAt || latest.startedAt)}>
                        {relativeTime(latest.finishedAt || latest.startedAt)}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {hasHistory && (
                      <button
                        type="button"
                        onClick={() => toggle(group.inputPath)}
                        aria-expanded={isExpanded}
                        className="rounded-full border border-border px-3 py-1 text-xs text-faint hover:text-text"
                      >
                        {t("transcriptionHistory.attempts", { count: group.attempts.length })}
                      </button>
                    )}
                    <span className={`rounded-full border px-3 py-1 text-xs ${statusClasses(latest.status)}`}>
                      {statusLabel(latest.status)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRetry(latest)}
                      // One run per file: no retry while any retry or batch is in
                      // flight, or while the backend still reports this file running.
                      disabled={isRetryPending || isTranscribePending || latest.status === "running"}
                      className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-xs font-medium text-text disabled:opacity-40 min-h-touch md:min-h-0"
                    >
                      {activeRetry ? t("transcriptionHistory.retrying") : t("transcriptionHistory.retry")}
                    </button>
                    {onRemove && (
                      <button
                        type="button"
                        // Removing the group clears every attempt for this file —
                        // leaving the older ones would rebuild the pile it replaced.
                        onClick={() => group.attempts.forEach((entry) => onRemove(entry))}
                        disabled={group.attempts.some((entry) => entry.id === removingId) || latest.status === "running"}
                        title={t("transcriptionHistory.remove")}
                        aria-label={t("transcriptionHistory.remove")}
                        className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-xs font-medium text-faint disabled:opacity-40"
                      >
                        {t("transcriptionHistory.remove")}
                      </button>
                    )}
                  </div>
                </div>
                {isExpanded && hasHistory && (
                  <ul className="mt-3 space-y-1 border-t border-border pt-2">
                    {group.attempts.map((entry) => (
                      <li key={entry.id} className="flex items-baseline justify-between gap-3 text-xs text-faint">
                        <span className="truncate" title={fullTime(entry.finishedAt || entry.startedAt)}>
                          {relativeTime(entry.finishedAt || entry.startedAt)}
                          {entry.errorSummary ? ` — ${entry.errorSummary}` : ""}
                        </span>
                        <span className={`shrink-0 rounded-full border px-2 py-1 ${statusClasses(entry.status)}`}>{statusLabel(entry.status)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
