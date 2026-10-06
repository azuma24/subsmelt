import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

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
        className="min-h-touch min-w-touch flex items-center justify-center rounded-sm border border-border bg-surface-raised text-muted hover:text-text hover:bg-surface-highlight"
      >
        <Icon name="more" />
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
            className="fixed z-50 min-w-[160px] rounded-md border border-border bg-surface py-1 shadow-2"
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
                className={`w-full px-3 py-2 text-left text-sm leading-6 min-h-touch md:min-h-0 hover:bg-surface-raised focus:bg-surface-raised disabled:opacity-40 ${item.danger ? "text-danger" : "text-text"}`}
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
