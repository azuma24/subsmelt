import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

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
    root: "rounded-md border border-border bg-surface",
    trigger: "px-4 py-3",
    panel: "border-t border-border px-4 py-3",
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
        className={`flex min-h-touch w-full items-center justify-between gap-3 text-sm font-medium text-text leading-6 ${styles.trigger}`}
      >
        <span>{title}</span>
        <Icon name="chevron-down" className={`text-faint transition-transform duration-fast ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div id={panelId} role="region" aria-labelledby={triggerId} className={styles.panel}>
          {children}
        </div>
      )}
    </div>
  );
}
