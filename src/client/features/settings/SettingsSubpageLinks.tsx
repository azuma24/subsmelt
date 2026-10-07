import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { Icon } from "../../ui/Icon";

/** Settings areas that are whole pages of their own, listed beside the sections. */
export const SETTINGS_SUBPAGES = [
  { path: "/settings/languages", labelKey: "nav.languages" },
  { path: "/settings/logs", labelKey: "nav.logs" },
] as const;

const VARIANT_CLASS = {
  nav: "flex items-center justify-between rounded-sm border border-transparent px-2 py-2 text-left text-sm text-muted transition-colors hover:bg-surface-raised hover:text-text",
  rows: "flex min-h-touch items-center justify-between rounded-md border border-border bg-surface px-4 text-sm font-medium text-text hover:bg-surface-raised",
} as const;

export function SettingsSubpageLinks({ variant }: { variant: keyof typeof VARIANT_CLASS }) {
  const { t } = useTranslation();
  return (
    <>
      {SETTINGS_SUBPAGES.map((page) => (
        <Link key={page.path} to={page.path} className={VARIANT_CLASS[variant]}>
          {t(page.labelKey)}
          <Icon name="chevron-right" className="text-faint" />
        </Link>
      ))}
    </>
  );
}
