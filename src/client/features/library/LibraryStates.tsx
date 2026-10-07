import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { ActionButton } from "../../ui/primitives";

export function LibraryNotice({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-base font-medium text-text">{title}</p>
      {body && <p className="max-w-md text-sm text-muted">{body}</p>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** Nothing scanned: say what the Library is for and where media comes from. */
export function LibraryEmpty() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-raised text-muted">
        <Icon name="library" size={20} />
      </span>
      <h2 className="text-lg font-semibold text-text">{t("library.empty.title")}</h2>
      <p className="max-w-md text-sm text-muted">{t("library.empty.body")}</p>
      <Link
        to="/settings?section=sources"
        className="mt-2 inline-flex min-h-touch items-center rounded-sm border border-border bg-surface px-4 text-sm font-medium text-text hover:bg-surface-raised"
      >
        {t("library.empty.action")}
      </Link>
    </div>
  );
}

export function LibraryLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <p className="max-w-md text-sm text-danger [overflow-wrap:anywhere]">{t("library.loadFailed", { message })}</p>
      <ActionButton variant="ghost" size="sm" onClick={onRetry}>
        {t("errors.retry")}
      </ActionButton>
    </div>
  );
}
