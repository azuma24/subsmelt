import type { ReactNode } from "react";
import { useIsMobile } from "../hooks";

interface PageHeaderProps {
  /** The page title. A string becomes the h1; a node can carry a breadcrumb. */
  title: ReactNode;
  subtitle?: ReactNode;
  /** Controls at the end of the title row. */
  actions?: ReactNode;
  /** Sits between the title and the actions and takes the spare width: a status line, tabs. */
  middle?: ReactNode;
  /** A second row: search, filters. */
  children?: ReactNode;
  /** Phones show the page name in the tab bar; the title is screen-reader only there. */
  titleHiddenBelowMd?: boolean;
  className?: string;
}

/**
 * The top of every page: one title size, one bar height, actions at the end,
 * an optional second row. Sticky so the actions stay reachable while the
 * body scrolls.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  middle,
  children,
  titleHiddenBelowMd = false,
  className = "",
}: PageHeaderProps) {
  return (
    <header className={`sticky top-0 z-30 shrink-0 border-b border-border bg-surface px-4 py-2 ${className}`}>
      {/* flex-auto, not flex-1: the title keeps its own width, so on a phone
          the actions wrap under it instead of squeezing it to a letter. */}
      <div className="flex min-h-touch flex-wrap items-center gap-x-4 gap-y-2">
        <div className={`min-w-0 ${middle ? "" : "flex-auto"} ${titleHiddenBelowMd ? "sr-only md:not-sr-only" : ""}`}>
          <h1 className="truncate text-lg font-semibold text-text">{title}</h1>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        {middle && <div className="min-w-0 flex-auto">{middle}</div>}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function EmptyHint({ text, subtext }: { text: string; subtext?: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-surface-raised px-4 py-12 text-center text-sm leading-6 text-muted">
      <p>{text}</p>
      {subtext && <p className="mt-2 text-xs leading-6 text-faint">{subtext}</p>}
    </div>
  );
}

export function DetailCard({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-surface-raised p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 break-all text-sm leading-6 text-text ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-md border border-border bg-surface p-4">
      <div>
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {description && <p className="mt-1 text-xs leading-6 text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

interface SelectionBarProps {
  count: number;
  children: ReactNode;
  onClear: () => void;
  clearLabel: string;
  summaryLabel: string;
  hintLabel?: string;
}

export function SelectionBar({ count, children, onClear, clearLabel, summaryLabel, hintLabel }: SelectionBarProps) {
  const isMobile = useIsMobile();
  if (count === 0) return null;
  return (
    <div
      className={`border-b border-accent-line bg-accent-soft px-4 py-3 ${isMobile ? "space-y-3" : "flex items-center justify-between gap-3"}`}
    >
      <div>
        <div className="text-sm font-medium text-text leading-6">{summaryLabel}</div>
        {hintLabel && <div className="text-xs text-muted leading-6">{hintLabel}</div>}
      </div>
      <div className="flex flex-wrap gap-2">
        {children}
        <button
          type="button"
          onClick={onClear}
          className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-xs font-medium text-muted"
        >
          {clearLabel}
        </button>
      </div>
    </div>
  );
}

interface TabItem {
  key: string;
  label: string;
  count?: number;
}

interface TabsProps {
  tabs: TabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeKey, onSelect, className = "" }: TabsProps) {
  return (
    <div
      role="tablist"
      className={`inline-flex gap-px overflow-x-auto rounded-sm border border-border bg-surface-raised p-1 ${className}`}
    >
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.key}
          role="tab"
          aria-selected={activeKey === tab.key}
          onClick={() => onSelect(tab.key)}
          className={`whitespace-nowrap rounded-sm px-3 py-1 min-h-touch text-xs leading-6 transition-colors ${activeKey === tab.key ? "bg-surface-highlight font-medium text-text" : "text-muted hover:text-text"}`}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && <span className="ml-1 text-xs text-faint">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
