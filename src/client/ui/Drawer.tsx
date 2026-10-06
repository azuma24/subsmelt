import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "./Button";

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
        className={`relative flex w-full ${width} flex-col border-l border-border bg-surface shadow-2 outline-hidden`}
      >
        <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <span id={titleId} className="text-sm font-semibold text-text leading-6">{title}</span>
          <IconButton icon="close" label={t("common.close")} onClick={onClose} />
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
