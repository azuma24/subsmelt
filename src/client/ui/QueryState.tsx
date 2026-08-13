import { useTranslation } from "react-i18next";
import { ActionButton } from "./primitives";

// Shared presentational components for surfacing React Query loading/error
// states consistently across pages. Purely presentational — callers wire these
// to their own query state (isLoading/isError/refetch). See frontend-audit §3.

export function PageLoading({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[160px] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span
        className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]"
        aria-hidden="true"
      />
      <p className="text-[13px] leading-6 text-[var(--text-3)]">{label ?? t("errors.loading")}</p>
    </div>
  );
}

export function PageError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex min-h-[160px] flex-col items-center justify-center gap-3 px-6 py-12 text-center"
    >
      <span className="text-2xl" aria-hidden="true">⚠</span>
      <p className="text-[13px] leading-6 text-[var(--text-2)]">{message ?? t("errors.loadFailed")}</p>
      {onRetry && (
        <ActionButton variant="ghost" size="sm" onClick={onRetry}>
          {t("errors.retry")}
        </ActionButton>
      )}
    </div>
  );
}

export function InlineError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--red-border)] bg-[var(--red-dim)] px-3 py-2 text-[12px] leading-6 text-[var(--red)]"
    >
      <span className="min-w-0 flex-1 break-words">{message ?? t("errors.loadFailed")}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md border border-[var(--red-border)] bg-transparent px-2.5 py-1 text-[11.5px] font-medium text-[var(--red)] transition-colors hover:bg-[var(--red-dim)]"
        >
          {t("errors.retry")}
        </button>
      )}
    </div>
  );
}
