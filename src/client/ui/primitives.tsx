import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { JobRow } from "../types";
import { STATUS_ICON, STATUS_LABEL_KEY } from "../app/constants";

export function StatusPill({ label, tone, truncate = false }: { label: string; tone: "green" | "emerald" | "blue" | "gray"; truncate?: boolean }) {
  const cls = {
    green: "bg-[var(--green-dim)] text-[var(--green)] border-[var(--green-border)]",
    emerald: "bg-[var(--green-dim)] text-[var(--green)] border-[var(--green-border)]",
    blue: "bg-[var(--accent-dim)] text-[var(--accent)] border-[var(--accent-border)]",
    gray: "bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--border)]",
  }[tone];
  return <div className={`rounded-full border px-3 py-1 text-[11.5px] leading-6 ${cls} ${truncate ? "max-w-[220px] truncate" : ""}`}>{label}</div>;
}

interface ActionButtonProps {
  children: ReactNode;
  onClick: () => void;
  className?: string;
  variant?: "primary" | "success" | "danger" | "ghost" | "warning";
  size?: "sm" | "md";
  disabled?: boolean;
  busy?: boolean;
}

export function ActionButton({ children, onClick, className = "", variant = "primary", size = "md", disabled = false, busy = false }: ActionButtonProps) {
  const cls = {
    primary: "bg-[var(--accent)] hover:brightness-110 text-white",
    success: "bg-[var(--green)] hover:brightness-110 text-black font-semibold",
    danger: "bg-transparent text-[var(--red)] border border-[var(--red-border)] hover:bg-[var(--red-dim)]",
    ghost: "bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text)] border border-[var(--border)]",
    warning: "bg-[var(--yellow-dim)] hover:brightness-110 text-[var(--yellow)] border border-[var(--yellow-border)]",
  }[variant];
  const sizeCls = size === "sm" ? "px-3 py-1.5 text-[12px]" : "px-4 py-2.5 text-[13px]";
  return <button onClick={onClick} disabled={disabled || busy} className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg text-center font-medium leading-6 transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${sizeCls} ${cls} ${className}`}>{children}</button>;
}

export function StatCard({ label, value, color, onClick }: { label: string; value: number | string; color: string; onClick?: () => void }) {
  const base = "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5";
  if (onClick) {
    return (
      <button onClick={onClick} className={`${base} text-left w-full cursor-pointer hover:border-[var(--accent-border)] transition-colors`}>
        <div className={`text-[26px] font-bold tabular-nums leading-none ${color}`}>{value}</div>
        <div className="mt-1.5 text-[11.5px] text-[var(--text-2)]">{label}</div>
      </button>
    );
  }
  return <div className={base}><div className={`text-[26px] font-bold tabular-nums leading-none ${color}`}>{value}</div><div className="mt-1.5 text-[11.5px] text-[var(--text-2)]">{label}</div></div>;
}

export function StatusBadge({ job, compact = false }: { job: JobRow; compact?: boolean }) {
  const { t } = useTranslation();
  const tone = job.status === "done"
    ? "bg-[var(--green-dim)] text-[var(--green)] border border-[var(--green-border)]"
    : job.status === "translating"
      ? "bg-[var(--accent-dim)] text-[var(--accent)] border border-[var(--accent-border)]"
      : job.status === "error"
        ? "bg-[var(--red-dim)] text-[var(--red)] border border-[var(--red-border)]"
        : "bg-[var(--surface-2)] text-[var(--text-2)] border border-[var(--border)]";
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${compact ? "text-[10.5px]" : "text-[11.5px]"} font-medium leading-6 ${tone}`}>{STATUS_ICON[job.status]} {STATUS_LABEL_KEY[job.status] ? t(STATUS_LABEL_KEY[job.status]) : job.status}{job.force ? " ⚡" : ""}{job.priority > 0 ? " 📌" : ""}</span>;
}

export function ProgressSmall({ pct, large = false }: { pct: number; large?: boolean }) {
  const boundedPct = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="flex items-center gap-2">
      <div
        className={`overflow-hidden rounded-full bg-[var(--surface-3)] ${large ? "h-2" : "h-[3px]"} flex-1`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={boundedPct}
        aria-label={`${boundedPct}%`}
      >
        <div className={`rounded-full bg-[var(--accent)] ${large ? "h-2" : "h-[3px]"}`} style={{ width: `${boundedPct}%` }} />
      </div>
      <span className="font-mono text-[11px] text-[var(--text-2)]">{boundedPct}%</span>
    </div>
  );
}

export function MiniBtn({ children, onClick, color = "default" }: { children: ReactNode; onClick: () => void; color?: string }) {
  const cls = color === "yellow"
    ? "bg-[var(--yellow-dim)] hover:brightness-110 text-[var(--yellow)] border border-[var(--yellow-border)]"
    : "bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-2)] hover:text-[var(--text)] border border-[var(--border)]";
  return <button onClick={onClick} className={`rounded-md px-2.5 py-1 text-[11px] leading-6 transition-colors ${cls}`}>{children}</button>;
}

export function Field({ label, value, onChange, placeholder, help, error, type = "text", required }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; help?: string; error?: string; type?: string; required?: boolean }) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const describedBy = error ? errorId : help ? helpId : undefined;

  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-[12px] font-medium text-[var(--text-2)]">
        {label} {required && <span className="text-[var(--red)]">*</span>}
      </label>
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        required={required}
        className={`w-full rounded-lg border bg-[var(--surface-2)] px-3 py-2 text-[13px] leading-6 text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)] ${error ? "border-[var(--red-border)]" : "border-[var(--border)]"}`}
      />
      {error && <p id={errorId} className="mt-1 text-[11.5px] leading-6 text-[var(--red)]">{error}</p>}
      {help && !error && <p id={helpId} className="mt-1 text-[11.5px] leading-6 text-[var(--text-3)]">{help}</p>}
    </div>
  );
}

export function EmptyHint({ text, subtext }: { text: string; subtext?: string }) {
  return <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-12 text-center text-[13px] leading-6 text-[var(--text-2)]"><p>{text}</p>{subtext && <p className="mt-2 text-[11.5px] leading-6 text-[var(--text-3)]">{subtext}</p>}</div>;
}

export function DetailCard({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4"><div className="text-[11.5px] text-[var(--text-2)]">{label}</div><div className={`mt-1 break-all text-[13px] leading-6 text-[var(--text)] ${mono ? "font-mono" : ""}`}>{value}</div></div>;
}

export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-[18px]"><div><h2 className="text-[13.5px] font-semibold text-[var(--text)]">{title}</h2>{description && <p className="mt-1 text-[11.5px] leading-6 text-[var(--text-2)]">{description}</p>}</div>{children}</section>;
}

export function HealthChips({ items }: { items: { label: string; status: "ok" | "fail" | "warn" }[] }) {
  const tone = {
    ok: "bg-[var(--green-dim)] text-[var(--green)] border-[var(--green-border)]",
    fail: "bg-[var(--red-dim)] text-[var(--red)] border-[var(--red-border)]",
    warn: "bg-[var(--yellow-dim)] text-[var(--yellow)] border-[var(--yellow-border)]",
  };
  const icon = { ok: "✓", fail: "✕", warn: "⚠" };
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item.label} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${tone[item.status]}`}>
          {icon[item.status]} {item.label}
        </span>
      ))}
    </div>
  );
}

// ── Phase 1 new primitives ──────────────────────────────────────────────────

interface AccordionProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}

export function Accordion({ title, defaultOpen = false, children, className = "" }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const triggerId = useId();
  return (
    <div className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] ${className}`}>
      <button
        type="button"
        id={triggerId}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-3 text-[13px] font-medium text-[var(--text)] leading-6"
      >
        <span>{title}</span>
        <span className={`text-[var(--text-3)] transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id={panelId} role="region" aria-labelledby={triggerId} className="border-t border-[var(--border)] px-4 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}

export function Drawer({ open, onClose, title, children, width = "max-w-md" }: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusable = panel?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (focusable || panel)?.focus();
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`relative flex w-full ${width} flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl outline-none`}
      >
        <div className="flex min-h-[50px] shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <span id={titleId} className="text-[13.5px] font-semibold text-[var(--text)] leading-6">{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

interface RowActionsMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface RowActionsMenuProps {
  items: RowActionsMenuItem[];
}

export function RowActionsMenu({ items }: RowActionsMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative inline-block"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--surface-3)]"
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div role="menu" className="absolute right-0 z-20 mt-1 min-w-[160px] rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { item.onClick(); setOpen(false); }}
                className={`w-full px-3 py-2 text-left text-[13px] leading-6 hover:bg-[var(--surface-2)] disabled:opacity-40 ${item.danger ? "text-[var(--red)]" : "text-[var(--text)]"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface SelectionBarProps {
  count: number;
  children: ReactNode;
  onClear: () => void;
  clearLabel: string;
  summaryLabel: string;
  hintLabel?: string;
  isMobile?: boolean;
}

export function SelectionBar({ count, children, onClear, clearLabel, summaryLabel, hintLabel, isMobile = false }: SelectionBarProps) {
  if (count === 0) return null;
  return (
    <div className={`border-b border-[var(--accent-border)] bg-[var(--accent-dim)] px-3.5 py-3 ${isMobile ? "space-y-3" : "flex items-center justify-between gap-3"}`}>
      <div>
        <div className="text-[13px] font-medium text-[var(--text)] leading-6">{summaryLabel}</div>
        {hintLabel && <div className="text-[11.5px] text-[var(--text-2)] leading-6">{hintLabel}</div>}
      </div>
      <div className="flex flex-wrap gap-2">
        {children}
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)]"
        >
          {clearLabel}
        </button>
      </div>
    </div>
  );
}

interface StatusStripSegment {
  key: string;
  label: string;
  count: number;
  color: string;
  activeColor: string;
}

interface StatusStripProps {
  segments: StatusStripSegment[];
  activeKey: string;
  onSelect: (key: string) => void;
}

export function StatusStrip({ segments, activeKey, onSelect }: StatusStripProps) {
  return (
    <div className="flex overflow-hidden rounded-xl border border-[var(--border)] divide-x divide-[var(--border)]">
      {segments.map((seg) => {
        const isActive = activeKey === seg.key;
        return (
          <button
            key={seg.key}
            type="button"
            onClick={() => onSelect(seg.key)}
            className={`flex-1 min-h-[44px] px-3 py-2 text-center transition-colors ${isActive ? "bg-[var(--surface-3)]" : "bg-[var(--surface)] hover:bg-[var(--surface-2)]"}`}
          >
            <div className={`text-[22px] font-bold tabular-nums leading-none ${isActive ? seg.activeColor : seg.color}`}>{seg.count}</div>
            <div className="mt-1 text-[11px] text-[var(--text-2)] leading-6">{seg.label}</div>
          </button>
        );
      })}
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
    <div role="tablist" className={`inline-flex gap-px overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-[2px] ${className}`}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={activeKey === tab.key}
          onClick={() => onSelect(tab.key)}
          className={`whitespace-nowrap rounded-[6px] px-[11px] py-[3px] min-h-[44px] text-[12px] leading-6 transition-colors ${activeKey === tab.key ? "bg-[var(--surface-3)] font-medium text-[var(--text)]" : "text-[var(--text-2)] hover:text-[var(--text)]"}`}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && (
            <span className="ml-1 text-[11px] text-[var(--text-3)]">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
