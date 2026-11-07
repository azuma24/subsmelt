import { useLayoutEffect, useRef } from "react";
import { Link, Outlet, useLocation, useMatch, useSearchParams } from "react-router-dom";
import { useIsMobile } from "../../hooks";
import { useTranslation } from "../../i18n";
import {
  SettingsSubpageLinks,
  SETTINGS_NAV_LINK,
  SETTINGS_NAV_ACTIVE,
  SETTINGS_NAV_IDLE,
} from "./SettingsSubpageLinks";
import { SETTINGS_SECTIONS, SETTINGS_SECTION_KEYS, settingsSection } from "./settings-navigation";

export function SettingsLayout() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const atOverview = useMatch("/settings") !== null;
  const [params] = useSearchParams();
  const activeSection = atOverview ? settingsSection(params.get("section")) : null;
  const scrollPane = useRef<HTMLDivElement>(null);

  // A section change keeps the settings form mounted. Only its scroll resets.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll resets on route and section changes, not on filter changes
  useLayoutEffect(() => {
    if (scrollPane.current) scrollPane.current.scrollTop = 0;
  }, [pathname, activeSection]);

  return (
    <div className={`flex h-full min-h-0 ${isMobile ? "flex-col" : ""}`}>
      {isMobile ? (
        !atOverview && (
          <nav
            aria-label={t("settings.title")}
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface px-3 py-1"
          >
            <Link
              to="/settings"
              className={`${SETTINGS_NAV_LINK} ${SETTINGS_NAV_IDLE} min-h-touch shrink-0 whitespace-nowrap`}
            >
              {t("settings.title")}
            </Link>
            <SettingsSubpageLinks variant="tabs" />
          </nav>
        )
      ) : (
        <nav
          aria-label={t("settings.title")}
          className="w-44 shrink-0 overflow-y-auto border-e border-border bg-canvas p-3 lg:w-48"
        >
          <p aria-hidden="true" className="px-2 pb-2 pt-1 text-xs font-medium text-muted">
            {t("settings.title")}
          </p>
          <div className="flex flex-col gap-px">
            {SETTINGS_SECTION_KEYS.map((key) => (
              <Link
                key={key}
                to={key === "llm" ? "/settings" : `/settings?section=${key}`}
                aria-current={activeSection === key ? "page" : undefined}
                className={`${SETTINGS_NAV_LINK} ${activeSection === key ? SETTINGS_NAV_ACTIVE : SETTINGS_NAV_IDLE}`}
              >
                {t(SETTINGS_SECTIONS[key])}
              </Link>
            ))}
          </div>
          <div className="mt-2 flex flex-col gap-px border-t border-border pt-2">
            <SettingsSubpageLinks variant="nav" />
          </div>
        </nav>
      )}
      <div ref={scrollPane} className="min-h-0 min-w-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
