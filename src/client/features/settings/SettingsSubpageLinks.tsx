import { NavLink } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { Icon } from "../../ui/Icon";

const SETTINGS_SUBPAGES = [
  { path: "/settings/languages", labelKey: "nav.languages" },
  { path: "/settings/usage", labelKey: "nav.usage" },
  { path: "/settings/logs", labelKey: "nav.logs" },
] as const;

export const SETTINGS_NAV_LINK = "flex items-center rounded-sm border px-2 py-2 text-sm leading-5 transition-colors";
export const SETTINGS_NAV_ACTIVE = "border-accent-line bg-accent-soft text-accent";
export const SETTINGS_NAV_IDLE = "border-transparent text-muted hover:bg-surface-raised hover:text-text";
const ROW_CLASS =
  "flex min-h-touch items-center justify-between rounded-md border border-border bg-surface px-4 text-sm font-medium text-text hover:bg-surface-raised";

export function SettingsSubpageLinks({ variant }: { variant: "nav" | "rows" | "tabs" }) {
  const { t } = useTranslation();
  return (
    <>
      {SETTINGS_SUBPAGES.map((page) => (
        <NavLink
          key={page.path}
          to={page.path}
          end
          className={({ isActive }) =>
            variant === "rows"
              ? ROW_CLASS
              : `${SETTINGS_NAV_LINK} ${isActive ? SETTINGS_NAV_ACTIVE : SETTINGS_NAV_IDLE} ${variant === "tabs" ? "min-h-touch shrink-0 whitespace-nowrap" : ""}`
          }
        >
          {t(page.labelKey)}
          {variant === "rows" && <Icon name="chevron-right" className="text-faint" />}
        </NavLink>
      ))}
    </>
  );
}
