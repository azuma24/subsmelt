import type { Dispatch, SetStateAction } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NAV_ITEMS } from "./constants";

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

      <div className="flex-1 space-y-0.5 overflow-y-auto p-1.5">
        {NAV_ITEMS.map((item) => {
          const isActive = currentPath === item.path;
          const showBadge = item.path === "/" && errorCount > 0;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              aria-label={t(item.labelKey)}
              title={t(item.labelKey)}
              className={`relative flex items-center gap-2.5 rounded-lg border px-[9px] py-[7px] text-[13px] transition-colors ${isActive ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]" : "border-transparent text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"}`}
            >
              <span className="w-[18px] shrink-0 text-center text-sm">{item.icon}</span>
              {/* Label hidden at compact width, shown at lg */}
              <span className="hidden flex-1 lg:inline">{t(item.labelKey)}</span>
              {showBadge && <span className="ml-auto min-w-[17px] rounded-full bg-[var(--red)] px-1.5 py-px text-center text-[9px] font-bold text-white">{errorCount}</span>}
            </NavLink>
          );
        })}
      </div>

      <div className="border-t border-[var(--border)] px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2.5">
        {/* Queue status dot — always shown */}
        <div className="flex items-center gap-2 px-0.5 py-1 text-[11.5px] text-[var(--text-2)]">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${queueRunning ? "bg-[var(--green)] shadow-[0_0_0_3px_var(--green-dim)] animate-pulse" : "bg-[var(--text-3)]"}`} />
          <span className="hidden lg:inline">{t(queueRunning ? "app.queueRunning" : "app.queueIdle")}</span>
        </div>
        {/* Watcher status */}
        <div className="flex items-center gap-2 px-0.5 py-1 text-[11.5px]">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${watcherRunning ? "bg-[var(--green)]" : "bg-[var(--text-3)]"}`} />
          <span className={`hidden lg:inline ${watcherRunning ? "text-[var(--text-2)]" : "text-[var(--text-3)]"}`}>{t(watcherRunning ? "app.watcherActive" : "app.watcherInactive")}</span>
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
      </div>
    </nav>
  );
}

export function TopStatusBar(_props: { queueRunning: boolean; watcherRunning: boolean; modelName: string }) {
  return <></>;
}

export function MobileBottomNav({ currentPath }: { currentPath: string }) {
  const { t } = useTranslation();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 grid h-[58px] grid-cols-5 border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden">
      {NAV_ITEMS.map((item) => {
        const active = currentPath === item.path;
        return (
          <NavLink
            key={item.path}
            to={item.path}
            className={`flex flex-col items-center justify-center gap-1 text-[10.5px] ${active ? "text-[var(--accent)]" : "text-[var(--text-2)]"}`}
          >
            <span className="text-[19px]">{item.icon}</span>
            <span>{t(item.labelKey)}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
