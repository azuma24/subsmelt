import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "./Icon";

export function StatusPill({ label, tone, truncate = false }: { label: string; tone: "green" | "emerald" | "blue" | "gray"; truncate?: boolean }) {
  const cls = {
    green: "bg-[var(--green-dim)] text-[var(--green)] border-[var(--green-border)]",
    emerald: "bg-[var(--green-dim)] text-[var(--green)] border-[var(--green-border)]",
    blue: "bg-[var(--accent-dim)] text-[var(--accent)] border-[var(--accent-border)]",
    gray: "bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--border)]",
  }[tone];
  return <div className={`rounded-full border px-3 py-1 text-xs leading-6 ${cls} ${truncate ? "max-w-[220px] truncate" : ""}`}>{label}</div>;
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
    primary: "bg-[var(--accent)] hover:brightness-110 text-[var(--on-accent)]",
    success: "bg-[var(--green)] hover:brightness-110 text-[var(--on-accent)] font-semibold",
    danger: "bg-transparent text-[var(--red)] border border-[var(--red-border)] hover:bg-[var(--red-dim)]",
    ghost: "bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text)] border border-[var(--border)]",
    warning: "bg-[var(--yellow-dim)] hover:brightness-110 text-[var(--yellow)] border border-[var(--yellow-border)]",
  }[variant];
  const sizeCls = size === "sm" ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm";
  return <button onClick={onClick} disabled={disabled || busy} className={`inline-flex min-h-touch items-center justify-center gap-2 rounded-sm text-center font-medium leading-6 transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${sizeCls} ${cls} ${className}`}>{children}</button>;
}

export type StatusTone = "ok" | "run" | "bad" | "warn" | "neutral";

/** What a status badge shows: every status carries a glyph and text, never color alone.
 *  The glyph is either a text character or a named icon. */
export interface StatusDescriptor {
  glyph: string | { icon: IconName };
  label: string;
  tone: StatusTone;
  /** Markers after the label (forced, pinned); each carries its own accessible name. */
  flags?: readonly StatusFlag[];
}

export interface StatusFlag {
  icon: IconName;
  label: string;
}

const STATUS_TONE_CLS: Record<StatusTone, string> = {
  ok: "bg-[var(--green-dim)] text-[var(--green)] border border-[var(--green-border)]",
  run: "bg-[var(--accent-dim)] text-[var(--accent)] border border-[var(--accent-border)]",
  bad: "bg-[var(--red-dim)] text-[var(--red)] border border-[var(--red-border)]",
  warn: "bg-[var(--yellow-dim)] text-[var(--yellow)] border border-dashed border-[var(--yellow-border)]",
  neutral: "bg-[var(--surface-2)] text-[var(--text-2)] border border-[var(--border)]",
};

export function StatusBadge({ status }: { status: StatusDescriptor }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium leading-6 ${STATUS_TONE_CLS[status.tone]}`}>
      {typeof status.glyph === "string" ? <span aria-hidden="true">{status.glyph}</span> : <Icon name={status.glyph.icon} />} {status.label}
      {status.flags?.map((flag) => <Icon key={flag.icon} name={flag.icon} label={flag.label} />)}
    </span>
  );
}

export function ProgressSmall({ pct, large = false }: { pct: number; large?: boolean }) {
  const boundedPct = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="flex items-center gap-2">
      <div
        className={`overflow-hidden rounded-full bg-[var(--surface-3)] ${large ? "h-2" : "h-1"} flex-1`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={boundedPct}
        aria-label={`${boundedPct}%`}
      >
        <div className={`rounded-full bg-[var(--accent)] ${large ? "h-2" : "h-1"}`} style={{ width: `${boundedPct}%` }} />
      </div>
      <span className="font-mono text-xs text-[var(--text-2)]">{boundedPct}%</span>
    </div>
  );
}

export function MiniBtn({ children, onClick, color = "default" }: { children: ReactNode; onClick: () => void; color?: string }) {
  const cls = color === "yellow"
    ? "bg-[var(--yellow-dim)] hover:brightness-110 text-[var(--yellow)] border border-[var(--yellow-border)]"
    : "bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-2)] hover:text-[var(--text)] border border-[var(--border)]";
  return <button onClick={onClick} className={`rounded-sm px-3 py-1 text-xs leading-6 transition-colors min-h-touch md:min-h-0 ${cls}`}>{children}</button>;
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  help?: string;
  error?: string;
  type?: string;
  required?: boolean;
  /** Shown but not editable, e.g. a setting an environment variable provides. */
  readOnly?: boolean;
  min?: number;
  max?: number;
  step?: number | "any";
}

export function Field({ label, value, onChange, placeholder, help, error, type = "text", required, readOnly = false, min, max, step }: FieldProps) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const describedBy = error ? errorId : help ? helpId : undefined;

  return (
    <div>
      <label htmlFor={inputId} className="mb-2 block text-xs font-medium text-[var(--text-2)]">
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
        readOnly={readOnly}
        min={min}
        max={max}
        step={step}
        className={`w-full rounded-sm border bg-[var(--surface-2)] px-3 py-2 text-sm leading-6 transition-colors focus:border-[var(--accent)] min-h-touch md:min-h-0 ${readOnly ? "cursor-not-allowed text-[var(--text-2)]" : "text-[var(--text)]"} ${error ? "border-[var(--red-border)]" : "border-[var(--border)]"}`}
      />
      {error && <p id={errorId} className="mt-1 text-xs leading-6 text-[var(--red)]">{error}</p>}
      {help && !error && <p id={helpId} className="mt-1 text-xs leading-6 text-[var(--text-3)]">{help}</p>}
    </div>
  );
}

export function EmptyHint({ text, subtext }: { text: string; subtext?: string }) {
  return <div className="rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-12 text-center text-sm leading-6 text-[var(--text-2)]"><p>{text}</p>{subtext && <p className="mt-2 text-xs leading-6 text-[var(--text-3)]">{subtext}</p>}</div>;
}

export function DetailCard({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-4"><div className="text-xs text-[var(--text-2)]">{label}</div><div className={`mt-1 break-all text-sm leading-6 text-[var(--text)] ${mono ? "font-mono" : ""}`}>{value}</div></div>;
}

export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="space-y-4 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4"><div><h2 className="text-sm font-semibold text-[var(--text)]">{title}</h2>{description && <p className="mt-1 text-xs leading-6 text-[var(--text-2)]">{description}</p>}</div>{children}</section>;
}

export function HealthChips({ items }: { items: { label: string; status: "ok" | "fail" | "warn" }[] }) {
  const tone = {
    ok: "bg-[var(--green-dim)] text-[var(--green)] border-[var(--green-border)]",
    fail: "bg-[var(--red-dim)] text-[var(--red)] border-[var(--red-border)]",
    warn: "bg-[var(--yellow-dim)] text-[var(--yellow)] border-[var(--yellow-border)]",
  };
  const icon = { ok: "✓", fail: "✕", warn: "⚠" };
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item.label} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${tone[item.status]}`}>
          {icon[item.status]} {item.label}
        </span>
      ))}
    </div>
  );
}

// ── Phase 1 new primitives ──────────────────────────────────────────────────

/**
 * `card` (default) — the standalone disclosure card used inside Settings:
 * bordered, filled, with a divider between the trigger and the panel.
 *
 * `inline` — the same disclosure *behaviour* (and the same ARIA wiring) with
 * the card chrome removed, for accordions that sit inside a surface that
 * already provides the border/background. Logs' "Filters" row previously got
 * this look by passing `className="border-none bg-transparent p-0"`, which read
 * as an accidental one-off override; the variant makes it a documented,
 * reusable choice instead.
 */
type AccordionVariant = "card" | "inline";

interface AccordionProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  variant?: AccordionVariant;
}

const ACCORDION_VARIANT_CLS: Record<AccordionVariant, { root: string; trigger: string; panel: string }> = {
  card: {
    root: "rounded-md border border-[var(--border)] bg-[var(--surface)]",
    trigger: "px-4 py-3",
    panel: "border-t border-[var(--border)] px-4 py-3",
  },
  inline: {
    root: "",
    trigger: "px-0 py-2",
    panel: "pt-1",
  },
};

export function Accordion({ title, defaultOpen = false, children, className = "", variant = "card" }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const triggerId = useId();
  const styles = ACCORDION_VARIANT_CLS[variant];
  return (
    <div className={`${styles.root} ${className}`}>
      <button
        type="button"
        id={triggerId}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className={`flex min-h-touch w-full items-center justify-between gap-3 text-sm font-medium text-[var(--text)] leading-6 ${styles.trigger}`}
      >
        <span>{title}</span>
        <span className={`text-[var(--text-3)] transition-transform duration-fast ${open ? "rotate-180" : ""}`} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id={panelId} role="region" aria-labelledby={triggerId} className={styles.panel}>
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
  const { t } = useTranslation();
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
      return;
    }
    // Trap Tab focus within the panel — aria-modal advertises the background as
    // unavailable, so keyboard focus must not escape to it.
    if (event.key === "Tab") {
      const panel = panelRef.current;
      if (!panel) return;
      const items = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (items.length === 0) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`relative flex w-full ${width} flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2 outline-none`}
      >
        <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <span id={titleId} className="text-sm font-semibold text-[var(--text)] leading-6">{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="min-h-touch min-w-touch flex items-center justify-center rounded-sm text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // Which item takes focus when the menu opens: first for click/ArrowDown,
  // last for ArrowUp, per the WAI-ARIA menu button pattern.
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");

  const menuItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  useEffect(() => {
    if (!open) return;
    const focusable = menuItems();
    focusable[initialFocus === "first" ? 0 : focusable.length - 1]?.focus();
  }, [open, initialFocus]);

  const openMenu = (focus: "first" | "last") => {
    setInitialFocus(focus);
    setOpen(true);
  };

  const moveFocus = (step: number) => {
    const focusable = menuItems();
    if (focusable.length === 0) return;
    const current = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const next = current < 0 ? 0 : (current + step + focusable.length) % focusable.length;
    focusable[next].focus();
  };

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const place = () => {
      const r = btnRef.current!.getBoundingClientRect();
      const w = 160;
      const h = items.length * 40 + 8;
      const flip = window.innerHeight - r.bottom < h && r.top > h;
      setPos({
        top: flip ? r.top - h - 4 : r.bottom + 4,
        left: Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, items.length]);

  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); moveFocus(1); break;
      case "ArrowUp": event.preventDefault(); moveFocus(-1); break;
      case "Home": event.preventDefault(); menuItems()[0]?.focus(); break;
      case "End": event.preventDefault(); menuItems().at(-1)?.focus(); break;
      case "Escape": event.preventDefault(); close(); break;
      // Tab leaves the menu: focus returns to the trigger first so the
      // browser's default Tab then lands on the control after it.
      case "Tab": close(); break;
    }
  };

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? close() : openMenu("first"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); openMenu("first"); }
          if (event.key === "ArrowUp") { event.preventDefault(); openMenu("last"); }
        }}
        aria-label={t("common.rowActions")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="min-h-touch min-w-touch flex items-center justify-center rounded-sm border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--surface-3)]"
      >
        ⋯
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden="true" />
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={t("common.rowActions")}
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-50 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2"
            onKeyDown={handleMenuKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => { item.onClick(); close(); }}
                className={`w-full px-3 py-2 text-left text-sm leading-6 min-h-touch md:min-h-0 hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] disabled:opacity-40 ${item.danger ? "text-[var(--red)]" : "text-[var(--text)]"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
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
    <div className={`border-b border-[var(--accent-border)] bg-[var(--accent-dim)] px-4 py-3 ${isMobile ? "space-y-3" : "flex items-center justify-between gap-3"}`}>
      <div>
        <div className="text-sm font-medium text-[var(--text)] leading-6">{summaryLabel}</div>
        {hintLabel && <div className="text-xs text-[var(--text-2)] leading-6">{hintLabel}</div>}
      </div>
      <div className="flex flex-wrap gap-2">
        {children}
        <button
          type="button"
          onClick={onClear}
          className="rounded-sm border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)]"
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
    <div role="tablist" className={`inline-flex gap-px overflow-x-auto rounded-sm border border-[var(--border)] bg-[var(--surface-2)] p-1 ${className}`}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={activeKey === tab.key}
          onClick={() => onSelect(tab.key)}
          className={`whitespace-nowrap rounded-sm px-3 py-1 min-h-touch text-xs leading-6 transition-colors ${activeKey === tab.key ? "bg-[var(--surface-3)] font-medium text-[var(--text)]" : "text-[var(--text-2)] hover:text-[var(--text)]"}`}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && (
            <span className="ml-1 text-xs text-[var(--text-3)]">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
