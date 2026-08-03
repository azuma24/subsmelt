import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptionHistoryEntry } from "../../types";
import { groupTranscriptionAttempts, retryableGroups, type TranscriptionGroup } from "./transcription-groups";
import { classifyError, errorHintKey } from "../../lib/errorTaxonomy";

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
  if (status === "succeeded") return "border-[var(--green-border)] bg-[var(--green-dim)] text-[var(--green)]";
  if (status === "failed") return "border-[var(--red-border)] bg-[var(--red-dim)] text-[var(--red)]";
  return "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]";
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
    <div className="p-3.5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-[13.5px] font-semibold text-[var(--text)]">{t("transcriptionHistory.title")}</h2>
          <p className="text-[11px] text-[var(--text-3)]">{t("transcriptionHistory.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--text-3)]">{t("transcriptionHistory.shown", { count: groups.length })}</span>
          {onRetryAllFailed && failed.length > 0 && (
            <button
              type="button"
              onClick={() => onRetryAllFailed(failed.map((group) => group.latest))}
              disabled={isRetryPending || isTranscribePending}
              className="rounded-lg border border-[var(--red-border)] bg-[var(--red-dim)] px-3 py-1.5 text-[11px] font-medium text-[var(--red)] disabled:opacity-40"
            >
              {t("transcriptionHistory.retryAllFailed", { count: failed.length })}
            </button>
          )}
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              disabled={isClearPending || clearableCount === 0}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[11px] font-medium text-[var(--text)] disabled:opacity-40"
            >
              {isClearPending ? t("transcriptionHistory.clearing") : t("transcriptionHistory.clear")}
            </button>
          )}
        </div>
      </div>
      {groups.length === 0 ? (
        <div className="text-[13px] text-[var(--text-3)]">{t("transcriptionHistory.empty")}</div>
      ) : (
        <div className="space-y-2">
          {groups.map((group: TranscriptionGroup) => {
            const { latest } = group;
            const activeRetry = transcribingPath === group.inputPath && isRetryPending;
            const isExpanded = expanded.has(group.inputPath);
            const hasHistory = group.attempts.length > 1;
            return (
              <div key={group.inputPath} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-[var(--text)]">{group.title}</div>
                    <div className="mt-1 text-[11px] text-[var(--text-3)]">
                      {latest.model} • {latest.language} • {latest.outputFormat.toUpperCase()} • {latest.postAction === "transcribe_and_translate" ? t("transcriptionHistory.postQueueTranslate") : t("transcriptionHistory.postTranscribeOnly")}
                    </div>
                    {latest.status === "failed" ? (
                      <div className="mt-1 text-[11px]">
                        {(() => {
                          const hint = errorHintKey(classifyError(latest.errorSummary));
                          // The raw text stays as the title so it is still
                          // copyable for a bug report, and is the whole message
                          // when the cause is not one we recognise.
                          return (
                            <span className="text-[var(--text-2)]" title={latest.errorSummary || undefined}>
                              {hint ? t(hint) : latest.errorSummary || t("transcriptionHistory.failedFallback")}
                            </span>
                          );
                        })()}
                      </div>
                    ) : (
                      <div className="mt-1 text-[11px] text-[var(--text-3)]">
                        {latest.finishedAt || latest.startedAt}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {hasHistory && (
                      <button
                        type="button"
                        onClick={() => toggle(group.inputPath)}
                        aria-expanded={isExpanded}
                        className="rounded-full border border-[var(--border)] px-3 py-1 text-[11px] text-[var(--text-3)] hover:text-[var(--text)]"
                      >
                        {t("transcriptionHistory.attempts", { count: group.attempts.length })}
                      </button>
                    )}
                    <span className={`rounded-full border px-3 py-1 text-[11px] ${statusClasses(latest.status)}`}>
                      {latest.status}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRetry(latest)}
                      disabled={activeRetry || isTranscribePending}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)] disabled:opacity-40"
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
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-3)] disabled:opacity-40"
                      >
                        {t("transcriptionHistory.remove")}
                      </button>
                    )}
                  </div>
                </div>
                {isExpanded && hasHistory && (
                  <ul className="mt-3 space-y-1 border-t border-[var(--border)] pt-2">
                    {group.attempts.map((entry) => (
                      <li key={entry.id} className="flex items-baseline justify-between gap-3 text-[11px] text-[var(--text-3)]">
                        <span className="truncate">
                          {entry.finishedAt || entry.startedAt}
                          {entry.errorSummary ? ` — ${entry.errorSummary}` : ""}
                        </span>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 ${statusClasses(entry.status)}`}>{entry.status}</span>
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
