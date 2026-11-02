import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { Icon } from "../../ui/Icon";

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
