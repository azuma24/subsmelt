import { useTranslation } from "react-i18next";
import type { TranscriptionHistoryEntry } from "../../types";

interface TranscriptionHistoryPanelProps {
  attempts: TranscriptionHistoryEntry[];
  transcribingPath: string | null;
  isRetryPending: boolean;
  isTranscribePending: boolean;
  onRetry: (attempt: TranscriptionHistoryEntry) => void;
  /** Omit to hide the clear/remove controls (read-only panel). */
  onClear?: () => void;
  onRemove?: (attempt: TranscriptionHistoryEntry) => void;
  isClearPending?: boolean;
  /** Id of the entry currently being removed, so only its button shows pending. */
  removingId?: string | null;
}

export function TranscriptionHistoryPanel({
  attempts,
  transcribingPath,
  isRetryPending,
  isTranscribePending,
  onRetry,
  onClear,
  onRemove,
  isClearPending = false,
  removingId = null,
}: TranscriptionHistoryPanelProps) {
  const { t } = useTranslation();
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
          <span className="text-[11px] text-[var(--text-3)]">{t("transcriptionHistory.shown", { count: attempts.length })}</span>
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
      {attempts.length === 0 ? (
        <div className="text-[13px] text-[var(--text-3)]">{t("transcriptionHistory.empty")}</div>
      ) : (
        <div className="space-y-2">
          {attempts.map((attempt) => {
            const title = attempt.inputPath.split(/[\\/]/).pop() || attempt.inputPath;
            const activeRetry = transcribingPath === attempt.inputPath && isRetryPending;
            return (
              <div key={attempt.id} className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-[var(--text)]">{title}</div>
                  <div className="mt-1 text-[11px] text-[var(--text-3)]">
                    {attempt.model} • {attempt.language} • {attempt.outputFormat.toUpperCase()} • {attempt.postAction === "transcribe_and_translate" ? t("transcriptionHistory.postQueueTranslate") : t("transcriptionHistory.postTranscribeOnly")}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--text-3)]">
                    {attempt.status === "failed" ? (attempt.errorSummary || "Transcription failed") : attempt.finishedAt || attempt.startedAt}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-3 py-1 text-[11px] ${attempt.status === "succeeded" ? "border-[var(--green-border)] bg-[var(--green-dim)] text-[var(--green)]" : attempt.status === "failed" ? "border-[var(--red-border)] bg-[var(--red-dim)] text-[var(--red)]" : "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]"}`}>
                    {attempt.status}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRetry(attempt)}
                    disabled={activeRetry || isTranscribePending}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)] disabled:opacity-40"
                  >
                    {activeRetry ? t("transcriptionHistory.retrying") : t("transcriptionHistory.retry")}
                  </button>
                  {onRemove && (
                    <button
                      type="button"
                      onClick={() => onRemove(attempt)}
                      disabled={removingId === attempt.id || attempt.status === "running"}
                      title={t("transcriptionHistory.remove")}
                      aria-label={t("transcriptionHistory.remove")}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-3)] disabled:opacity-40"
                    >
                      {t("transcriptionHistory.remove")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
