import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isNavActive, NAV_GROUPS, NAV_ITEMS, navItemsInGroup } from "./constants";
import { Icon, type IconName } from "../ui/Icon";
import { LlmStatusPopover } from "./LlmStatusPopover";
import {
  getThemePref,
  setThemePref,
  THEME_PREFS,
  type ThemePref,
} from "../lib/theme";

const THEME_ICON: Record<ThemePref, IconName> = {
  system: "theme-system",
  dark: "theme-dark",
  light: "theme-light",
};

/** One-click theme cycle (System → Dark → Light) in the global chrome, mirroring
 *  the Settings → Interface control. Persists via setThemePref. */
function ThemeToggle() {
  const { t } = useTranslation();
  const [pref, setPref] = useState<ThemePref>(getThemePref());
  const cycle = () => {
    // Read fresh from storage, not the closed-over state: the Settings → Interface
    // control writes the same key without notifying us, so `pref` can be stale.
    const next =
      THEME_PREFS[
        (THEME_PREFS.indexOf(getThemePref()) + 1) % THEME_PREFS.length
      ];
    setPref(next);
    setThemePref(next);
  };
  const label = t(`settings.interface.theme_${pref}`);
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`${t("settings.interface.theme")}: ${label}`}
      title={`${t("settings.interface.theme")}: ${label}`}
      className="mt-2 flex w-full items-center gap-2 rounded-sm border border-[var(--border)] bg-[var(--surface-2)] px-2 py-2 text-xs text-[var(--text-2)] transition-colors hover:text-[var(--text)] hover:border-[var(--accent-border)]"
    >
      <Icon name={THEME_ICON[pref]} />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

interface DesktopSidebarProps {
  queueRunning: boolean;
  errorCount: number;
  watcherRunning: boolean;
  currentPath: string;
}

export function DesktopSidebar({
  queueRunning,
  errorCount,
  watcherRunning,
  currentPath,
}: DesktopSidebarProps) {
  const { t } = useTranslation();
  return (
    // Phase 5: auto-compact at small desktop widths (w-20 compact, lg:w-52 full)
    <nav className="flex h-full min-h-0 w-20 lg:w-52 shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface)]">
      {/* Logo row — version shown as tooltip on logo per Phase 5 */}
      <div className="flex h-12 items-center gap-3 border-b border-[var(--border)] px-4">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-gradient-to-br from-[#4493f8] to-[#a371f7] text-white cursor-default"
          title={`SubSmelt v${__APP_VERSION__}`}
        >
          <Icon name="logo" />
        </div>
        {/* hidden at compact width, shown at lg */}
        <div className="hidden min-w-0 lg:block">
          <h1 className="text-sm font-semibold leading-tight tracking-[-0.3px] text-[var(--text)]">
            SubSmelt
          </h1>
          {/* Version line hidden — promoted to logo tooltip */}
        </div>
      </div>

      {/* Grouped destinations: operate / create / system. The section labels
          are text-only affordances that would clutter the w-20 compact rail, so
          below `lg` the divider rule carries the grouping on its own and the
          list keeps its accessible name via aria-label. */}
      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {NAV_GROUPS.map((group, index) => {
          const items = navItemsInGroup(group.id);
          if (items.length === 0) return null;
          return (
            <div
              key={group.id}
              className={
                index > 0 ? "mt-2 border-t border-[var(--border-sub)] pt-2" : ""
              }
            >
              <div
                aria-hidden="true"
                className="hidden px-2 pb-1 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-3)] lg:block"
              >
                {t(group.labelKey)}
              </div>
              <ul
                role="list"
                aria-label={t(group.labelKey)}
                className="space-y-1"
              >
                {items.map((item) => {
                  const isActive = isNavActive(item, currentPath);
                  const showBadge = item.path === "/activity" && errorCount > 0;
                  return (
                    <li key={item.path}>
                      <NavLink
                        to={item.path}
                        end={item.path === "/"}
                        aria-label={t(item.labelKey)}
                        title={t(item.labelKey)}
                        className={`relative flex items-center gap-3 rounded-sm border px-2 py-2 text-sm transition-colors ${isActive ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]" : "border-transparent text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"}`}
                      >
                        <Icon name={item.icon} />
                        {/* Label hidden at compact width, shown at lg */}
                        <span className="hidden flex-1 lg:inline">
                          {t(item.labelKey)}
                        </span>
                        {showBadge && (
                          <span className="absolute right-1 top-0 min-w-4 rounded-full lg:static lg:ml-auto bg-[var(--red)] px-2 py-px text-center text-xs font-semibold text-[var(--on-accent)]">
                            {errorCount}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

        {/* Status block — sits right under the Settings row. The four lines
            stay separate (Queue, Watcher, LLM, theme); the top border keeps this
            block visually apart from the nav links above it. */}
        <div className="mt-2 border-t border-[var(--border-sub)] pt-2">
          {/* Queue status dot — always shown. The label is sr-only below lg (where
              the sidebar is compact) so the status never reduces to color alone;
              `title` surfaces it on hover at compact width. */}
          <div
            className="flex items-center gap-2 px-1 py-1 text-xs text-[var(--text-2)]"
            title={t(queueRunning ? "app.queueRunning" : "app.queueIdle")}
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${queueRunning ? "bg-[var(--green)] ring-[3px] ring-[var(--green-dim)] animate-pulse" : "bg-[var(--text-3)]"}`}
            />
            <span className="sr-only lg:not-sr-only">
              {t(queueRunning ? "app.queueRunning" : "app.queueIdle")}
            </span>
          </div>
          {/* Watcher status */}
          <div
            className="flex items-center gap-2 px-1 py-1 text-xs"
            title={t(
              watcherRunning ? "app.watcherActive" : "app.watcherInactive",
            )}
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${watcherRunning ? "bg-[var(--green)]" : "bg-[var(--text-3)]"}`}
            />
            <span
              className={`sr-only lg:not-sr-only ${watcherRunning ? "text-[var(--text-2)]" : "text-[var(--text-3)]"}`}
            >
              {t(watcherRunning ? "app.watcherActive" : "app.watcherInactive")}
            </span>
          </div>
          {/* LLM connections: which one is translating, which are offline.
              Opens a popover listing the whole pool. */}
          <LlmStatusPopover placement="side" compactBelowLg />
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}

/** Non-color cue for the active mobile cell: a top indicator bar + bolder
 *  weight, so selection isn't signalled by accent tint alone. */
function MobileTabIndicator() {
  return (
    <span
      aria-hidden="true"
      className="absolute inset-x-4 top-0 rounded-full border-t-2 border-[var(--accent)]"
    />
  );
}

export function MobileBottomNav({ currentPath }: { currentPath: string }) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("nav.primary")}
      className="fixed inset-x-0 bottom-0 z-30 grid h-[58px] border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
      style={{ gridTemplateColumns: `repeat(${NAV_ITEMS.length}, minmax(0, 1fr))` }}
    >
      {NAV_ITEMS.map((item) => {
        const active = isNavActive(item, currentPath);
        return (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={`relative flex min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs ${active ? "font-semibold text-[var(--accent)]" : "text-[var(--text-2)]"}`}
          >
            {active && <MobileTabIndicator />}
            <Icon name={item.icon} size={20} />
            <span className="max-w-full truncate">{t(item.labelKey)}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
