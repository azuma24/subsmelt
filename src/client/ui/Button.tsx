import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

interface ActionButtonProps {
  children: ReactNode;
  onClick: () => void;
  className?: string;
  variant?: "primary" | "success" | "danger" | "ghost" | "warning";
  size?: "sm" | "md";
  disabled?: boolean;
  busy?: boolean;
}

export function ActionButton({
  children,
  onClick,
  className = "",
  variant = "primary",
  size = "md",
  disabled = false,
  busy = false,
}: ActionButtonProps) {
  const cls = {
    primary: "bg-accent hover:brightness-110 text-accent-text",
    success: "bg-success hover:brightness-110 text-accent-text font-semibold",
    danger: "bg-transparent text-danger border border-danger-line hover:bg-danger-soft",
    ghost: "bg-surface-raised hover:bg-surface-highlight text-text border border-border",
    warning: "bg-warning-soft hover:brightness-110 text-warning border border-warning-line",
  }[variant];
  const sizeCls = size === "sm" ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex min-h-touch items-center justify-center gap-2 rounded-sm text-center font-medium leading-6 transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${sizeCls} ${cls} ${className}`}
    >
      {children}
    </button>
  );
}

export type MiniBtnTone = "default" | "warning";

/** A compact secondary action inside a row or a card. */
export function MiniBtn({
  children,
  onClick,
  tone = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: MiniBtnTone;
}) {
  const cls =
    tone === "warning"
      ? "bg-warning-soft hover:brightness-110 text-warning border border-warning-line"
      : "bg-surface-raised hover:bg-surface-highlight text-muted hover:text-text border border-border";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-sm px-3 py-1 text-xs leading-6 transition-colors min-h-touch md:min-h-0 ${cls}`}
    >
      {children}
    </button>
  );
}

export type IconButtonVariant = "ghost" | "outline" | "danger";

const ICON_BUTTON_CLS: Record<IconButtonVariant, string> = {
  ghost: "text-muted hover:bg-surface-raised hover:text-text",
  outline: "border border-border bg-surface-raised text-muted hover:bg-surface-highlight hover:text-text",
  danger: "text-danger hover:bg-danger-soft",
};

interface IconButtonProps {
  icon: IconName;
  /** The accessible name, also shown as the tooltip. */
  label: string;
  onClick?: () => void;
  variant?: IconButtonVariant;
  disabled?: boolean;
  /** For a toggle: whether it is on. */
  pressed?: boolean;
  className?: string;
  type?: "button" | "submit";
}

/** A square, touch-sized button that is only an icon, with its name for assistive tech. */
export function IconButton({
  icon,
  label,
  onClick,
  variant = "ghost",
  disabled = false,
  pressed,
  className = "",
  type = "button",
}: IconButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${ICON_BUTTON_CLS[variant]} ${className}`}
    >
      <Icon name={icon} />
    </button>
  );
}
