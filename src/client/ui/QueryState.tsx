import { useTranslation } from "react-i18next";
import { ActionButton } from "./primitives";
import { Icon } from "./Icon";

// Shared presentational components for surfacing React Query loading/error
// states consistently across pages. Purely presentational — callers wire these
// to their own query state (isLoading/isError/refetch).

export function PageLoading({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[160px] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden="true" />
      <p className="text-sm leading-6 text-faint">{label ?? t("errors.loading")}</p>
    </div>
  );
}

export function PageError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex min-h-[160px] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <Icon name="warning" size={20} className="text-warning" />
      <p className="text-sm leading-6 text-muted">{message ?? t("errors.loadFailed")}</p>
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
      className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-danger-line bg-danger-soft px-3 py-2 text-xs leading-6 text-danger"
    >
      <span className="min-w-0 flex-1 break-words">{message ?? t("errors.loadFailed")}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-sm border border-danger-line bg-transparent px-3 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger-soft"
        >
          {t("errors.retry")}
        </button>
      )}
    </div>
  );
}
