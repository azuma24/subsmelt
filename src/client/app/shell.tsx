import { useState, type Dispatch, type SetStateAction } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  MOBILE_OVERFLOW_NAV,
  MOBILE_PRIMARY_NAV,
  NAV_GROUPS,
  navItemsInGroup,
} from "./constants";
import { Drawer } from "../ui/primitives";
import { getThemePref, setThemePref, THEME_PREFS, type ThemePref } from "../lib/theme";

const THEME_ICON: Record<ThemePref, string> = { system: "🖥", dark: "🌙", light: "☀️" };

/** One-click theme cycle (System → Dark → Light) in the global chrome, mirroring
 *  the Settings → Interface control. Persists via setThemePref. */
function ThemeToggle() {
  const { t } = useTranslation();
  const [pref, setPref] = useState<ThemePref>(getThemePref());
  const cycle = () => {
    // Read fresh from storage, not the closed-over state: the Settings → Interface
    // control writes the same key without notifying us, so `pref` can be stale.
    const next = THEME_PREFS[(THEME_PREFS.indexOf(getThemePref()) + 1) % THEME_PREFS.length];
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
      className="mt-1.5 flex w-full items-center gap-2 rounded-[7px] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-[11.5px] text-[var(--text-2)] transition-colors hover:text-[var(--text)] hover:border-[var(--accent-border)]"
    >
      <span className="w-[18px] shrink-0 text-center text-sm leading-none">{THEME_ICON[pref]}</span>
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

interface DesktopSidebarProps {
  collapsed?: boolean;
  setCollapsed?: Dispatch<SetStateAction<boolean>>;
  queueRunning: boolean;
  errorCount: number;
  modelName: string;
  watcherRunning: boolean;
  currentPath: string;
}

export function DesktopSidebar({
  queueRunning,
  errorCount,
  modelName,
  watcherRunning,
  currentPath,
}: DesktopSidebarProps) {
  const { t } = useTranslation();
  return (
    // Phase 5: auto-compact at small desktop widths (w-20 compact, lg:w-52 full)
    <nav className="flex w-20 lg:w-52 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
      {/* Logo row — version shown as tooltip on logo per Phase 5 */}
      <div className="flex h-[50px] items-center gap-2.5 border-b border-[var(--border)] px-3.5">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-gradient-to-br from-[#4493f8] to-[#a371f7] text-sm cursor-default"
          title={`SubSmelt v${__APP_VERSION__}`}
        >
          🎬
        </div>
        {/* hidden at compact width, shown at lg */}
        <div className="hidden min-w-0 lg:block">
          <h1 className="text-sm font-semibold leading-tight tracking-[-0.3px] text-[var(--text)]">SubSmelt</h1>
          {/* Version line hidden — promoted to logo tooltip */}
        </div>
      </div>

      {/* Grouped destinations: operate / create / system. The section labels
          are text-only affordances that would clutter the w-20 compact rail, so
          below `lg` the divider rule carries the grouping on its own and the
          list keeps its accessible name via aria-label. */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {NAV_GROUPS.map((group, index) => {
          const items = navItemsInGroup(group.id);
          if (items.length === 0) return null;
          return (
            <div key={group.id} className={index > 0 ? "mt-2 border-t border-[var(--border-sub)] pt-2" : ""}>
              <div aria-hidden="true" className="hidden px-[9px] pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)] lg:block">
                {t(group.labelKey)}
              </div>
              <ul role="list" aria-label={t(group.labelKey)} className="space-y-0.5">
                {items.map((item) => {
                  const isActive = currentPath === item.path;
                  const showBadge = item.path === "/" && errorCount > 0;
                  return (
                    <li key={item.path}>
                      <NavLink
                        to={item.path}
                        aria-label={t(item.labelKey)}
                        title={t(item.labelKey)}
                        className={`relative flex items-center gap-2.5 rounded-lg border px-[9px] py-[7px] text-[13px] transition-colors ${isActive ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]" : "border-transparent text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"}`}
                      >
                        <span className="w-[18px] shrink-0 text-center text-sm">{item.icon}</span>
                        {/* Label hidden at compact width, shown at lg */}
                        <span className="hidden flex-1 lg:inline">{t(item.labelKey)}</span>
                        {showBadge && <span className="ml-auto min-w-[17px] rounded-full bg-[var(--red)] px-1.5 py-px text-center text-[9px] font-bold text-[var(--on-accent)]">{errorCount}</span>}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="border-t border-[var(--border)] px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2.5">
        {/* Queue status dot — always shown. The label is sr-only below lg (where
            the sidebar is compact) so the status never reduces to color alone;
            `title` surfaces it on hover at compact width. */}
        <div className="flex items-center gap-2 px-0.5 py-1 text-[11.5px] text-[var(--text-2)]" title={t(queueRunning ? "app.queueRunning" : "app.queueIdle")}>
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${queueRunning ? "bg-[var(--green)] shadow-[0_0_0_3px_var(--green-dim)] animate-pulse" : "bg-[var(--text-3)]"}`} />
          <span className="sr-only lg:not-sr-only">{t(queueRunning ? "app.queueRunning" : "app.queueIdle")}</span>
        </div>
        {/* Watcher status */}
        <div className="flex items-center gap-2 px-0.5 py-1 text-[11.5px]" title={t(watcherRunning ? "app.watcherActive" : "app.watcherInactive")}>
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${watcherRunning ? "bg-[var(--green)]" : "bg-[var(--text-3)]"}`} />
          <span className={`sr-only lg:not-sr-only ${watcherRunning ? "text-[var(--text-2)]" : "text-[var(--text-3)]"}`}>{t(watcherRunning ? "app.watcherActive" : "app.watcherInactive")}</span>
        </div>
        {/* Phase 5: model-name badge demoted to tooltip — still rendered but compact */}
        {modelName && (
          <div
            className="mt-1.5 hidden lg:flex items-center gap-1.5 rounded-[7px] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1"
            title={modelName}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
            <span className="truncate font-mono text-[11px] text-[var(--text-2)]">{modelName}</span>
          </div>
        )}
        <ThemeToggle />
      </div>
    </nav>
  );
}

/** Non-color cue for the active mobile cell: a top indicator bar + bolder
 *  weight, so selection isn't signalled by accent tint alone. */
function MobileTabIndicator() {
  return <span aria-hidden="true" className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-[var(--accent)]" />;
}

export function MobileBottomNav({ currentPath }: { currentPath: string }) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  // The bar carries the primary destinations plus a "More" cell; everything the
  // bar drops stays one tap behind that cell (two taps in total).
  const overflowActive = MOBILE_OVERFLOW_NAV.some((item) => item.path === currentPath);
  const moreLabel = t("nav.more");
  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid h-[58px] border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
        style={{ gridTemplateColumns: `repeat(${MOBILE_PRIMARY_NAV.length + (MOBILE_OVERFLOW_NAV.length > 0 ? 1 : 0)}, minmax(0, 1fr))` }}
      >
        {MOBILE_PRIMARY_NAV.map((item) => {
          const active = currentPath === item.path;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={`relative flex flex-col items-center justify-center gap-1 text-[11px] ${active ? "font-semibold text-[var(--accent)]" : "text-[var(--text-2)]"}`}
            >
              {active && <MobileTabIndicator />}
              <span aria-hidden="true" className="text-[19px]">{item.icon}</span>
              <span>{t(item.labelKey)}</span>
            </NavLink>
          );
        })}
        {MOBILE_OVERFLOW_NAV.length > 0 && (
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-label={moreLabel}
            className={`relative flex flex-col items-center justify-center gap-1 text-[11px] ${overflowActive ? "font-semibold text-[var(--accent)]" : "text-[var(--text-2)]"}`}
          >
            {overflowActive && <MobileTabIndicator />}
            <span aria-hidden="true" className="text-[19px]">⋯</span>
            <span>{moreLabel}</span>
          </button>
        )}
      </nav>
      <Drawer open={moreOpen} onClose={() => setMoreOpen(false)} title={moreLabel}>
        <ul role="list" className="space-y-1">
          {MOBILE_OVERFLOW_NAV.map((item) => {
            const active = currentPath === item.path;
            return (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  onClick={() => setMoreOpen(false)}
                  className={`flex min-h-[44px] items-center gap-3 rounded-lg border px-3 py-2 text-[13.5px] transition-colors ${active ? "border-[var(--accent-border)] bg-[var(--accent-dim)] font-semibold text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"}`}
                >
                  <span aria-hidden="true" className="w-[22px] shrink-0 text-center text-[17px]">{item.icon}</span>
                  <span className="flex-1">{t(item.labelKey)}</span>
                  {active && <span aria-hidden="true">✓</span>}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </Drawer>
    </>
  );
}
