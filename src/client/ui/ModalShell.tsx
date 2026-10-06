import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface ModalShellProps {
  titleId?: string;
  title?: string;
  children: ReactNode;
  onClose: () => void;
  panelClassName?: string;
  overlayClassName?: string;
  labelledBy?: string;
}

export function ModalShell({
  titleId,
  title,
  children,
  onClose,
  panelClassName = "w-full max-w-lg rounded-md border border-border bg-surface p-6",
  overlayClassName = "fixed inset-0 z-50 bg-scrim p-4",
  labelledBy,
}: ModalShellProps) {
  const generatedTitleId = useId();
  const resolvedTitleId = titleId || generatedTitleId;
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // A click's target is the common ancestor of mousedown and mouseup, so a
  // text selection that starts in the panel and ends over the backdrop reads
  // as a backdrop click. Close only when the press started there too.
  const pressStartedOnBackdrop = useRef(false);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusable = getFocusableElements(panel);
    (focusable[0] || panel)?.focus();

    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = getFocusableElements(panelRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={overlayClassName}
      onMouseDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressStartedOnBackdrop.current && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy || (title ? resolvedTitleId : undefined)}
        tabIndex={-1}
        className={panelClassName}
        onKeyDown={handleKeyDown}
      >
        {title && (
          <h3 id={resolvedTitleId} className="text-base font-semibold text-text">
            {title}
          </h3>
        )}
        {children}
      </div>
    </div>
  );
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    return !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true";
  });
}
