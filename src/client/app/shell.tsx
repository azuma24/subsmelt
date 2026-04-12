import type { Dispatch, SetStateAction } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NAV_ITEMS } from "./constants";
import { StatusPill } from "../ui/primitives";

interface DesktopSidebarProps {
  collapsed: boolean;
  setCollapsed: Dispatch<SetStateAction<boolean>>;
  queueRunning: boolean;
  errorCount: number;
  modelName: string;
  watcherRunning: boolean;
  currentPath: string;
}

export function DesktopSidebar({
  collapsed,
  setCollapsed,
  queueRunning,
  errorCount,
  modelName,
  watcherRunning,
  currentPath,
}: DesktopSidebarProps) {
  const { t } = useTranslation();
  return (
    <nav className={`${collapsed ? "w-20" : "w-52"} bg-gray-900 border-r border-gray-800 flex flex-col transition-all duration-200 shrink-0`}>
      <div className="p-4 border-b border-gray-800 flex items-center gap-3">
        <button onClick={() => setCollapsed((c) => !c)} className="h-10 w-10 rounded-2xl bg-gray-800 hover:bg-gray-700 text-lg">🎬</button>
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-white leading-tight">SubSmelt</h1>
            <p className="text-[10px] font-mono text-gray-500 leading-tight">v{__APP_VERSION__}</p>
          </div>
        )}
      </div>

      <div className="flex-1 py-3 px-2 space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive = currentPath === item.path;
          const showBadge = item.path === "/" && errorCount > 0;
          return (
            <NavLink key={item.path} to={item.path} className={`w-full text-left px-3 py-3 rounded-2xl text-sm flex items-center gap-3 transition-colors relative ${isActive ? "bg-blue-600/15 text-white border border-blue-500/30" : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/60"}`}>
              <span className="text-lg shrink-0">{item.icon}</span>
              {!collapsed && <span className="flex-1">{t(item.labelKey)}</span>}
              {showBadge && <span className="absolute top-2 right-2 bg-red-600 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">{errorCount}</span>}
            </NavLink>
          );
        })}
      </div>

      <div className="border-t border-gray-800 p-4 space-y-3">
        <div className="grid grid-cols-1 gap-2">
          <SidebarStatus label={t(queueRunning ? "app.queueRunning" : "app.queueIdle")} dot={queueRunning ? "bg-green-500 animate-pulse" : "bg-gray-600"} collapsed={collapsed} />
          <SidebarStatus label={t(watcherRunning ? "app.watcherActive" : "app.watcherInactive")} dot={watcherRunning ? "bg-emerald-500" : "bg-gray-600"} collapsed={collapsed} />
        </div>
        {!collapsed && modelName && <div className="rounded-xl border border-gray-800 bg-gray-950/60 p-3 text-[11px] text-gray-500 truncate" title={modelName}>{modelName}</div>}
      </div>
    </nav>
  );
}

function SidebarStatus({ label, dot, collapsed }: { label: string; dot: string; collapsed: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-gray-950/60 border border-gray-800 px-3 py-2">
      <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dot}`} />
      {!collapsed && <span className="text-[11px] text-gray-500 truncate">{label}</span>}
    </div>
  );
}

export function TopStatusBar({ queueRunning, watcherRunning, modelName }: { queueRunning: boolean; watcherRunning: boolean; modelName: string }) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-20 border-b border-gray-800/80 bg-gray-950/90 backdrop-blur">
      <div className="flex items-center gap-2 overflow-x-auto px-4 py-3 text-xs text-gray-400">
        <StatusPill label={t(queueRunning ? "app.queueRunning" : "app.queueIdle")} tone={queueRunning ? "green" : "gray"} />
        <StatusPill label={t(watcherRunning ? "app.watcherActive" : "app.watcherInactive")} tone={watcherRunning ? "emerald" : "gray"} />
        {modelName && <StatusPill label={modelName} tone="blue" truncate />}
      </div>
    </div>
  );
}

export function MobileBottomNav({ currentPath }: { currentPath: string }) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-800 bg-gray-950/95 backdrop-blur md:hidden">
      <div className="grid grid-cols-4 gap-1 p-2">
        {NAV_ITEMS.map((item) => {
          const active = currentPath === item.path;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={`flex flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 text-[11px] ${active ? "bg-blue-600/15 text-white" : "text-gray-500"}`}
            >
              <span className="text-base">{item.icon}</span>
              <span>{t(item.labelKey)}</span>
            </NavLink>
          );
        })}
      </div>
    </div>
  );
}
