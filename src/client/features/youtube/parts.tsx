import type { ReactNode } from "react";

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full border border-border px-2 text-xs leading-5 text-muted">
      {children}
    </span>
  );
}

export type CountTone = "ok" | "run" | "bad" | "neutral";

const COUNT_TONE: Record<CountTone, string> = {
  ok: "border-success-line text-success",
  run: "border-accent-line text-accent",
  bad: "border-danger-line text-danger",
  neutral: "border-border text-muted",
};

export function CountChip({ n, label, tone = "neutral" }: { n: number; label: string; tone?: CountTone }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 text-xs leading-6 ${COUNT_TONE[tone]}`}>
      <b className="font-semibold tabular-nums">{n}</b> {label}
    </span>
  );
}

export type BannerTone = "warn" | "bad" | "info";

const BANNER_TONE: Record<BannerTone, { box: string; glyph: string }> = {
  warn: { box: "border-warning-line bg-warning-soft text-warning", glyph: "!" },
  bad: { box: "border-danger-line bg-danger-soft text-danger", glyph: "✕" },
  info: { box: "border-accent-line bg-accent-soft text-accent", glyph: "i" },
};

export function Banner({ tone, title, children, action, glyph }: { tone: BannerTone; title: string; children?: ReactNode; action?: ReactNode; glyph?: string }) {
  const style = BANNER_TONE[tone];
  return (
    <div role={tone === "info" ? "status" : "alert"} className={`flex flex-wrap items-start gap-3 rounded-md border px-4 py-3 ${style.box}`}>
      <span aria-hidden="true" className="mt-1 flex h-5 min-w-6 shrink-0 items-center justify-center rounded-full border border-current px-1 text-xs font-semibold">
        {glyph ?? style.glyph}
      </span>
      <p className="min-w-0 flex-1 text-sm leading-6 text-text">
        <strong className="font-semibold">{title}</strong>
        {children && <> {children}</>}
      </p>
      {action}
    </div>
  );
}

/** A row of mutually exclusive buttons. Each option may carry a second, smaller line. */
export function Segmented<T extends string>({
  labelId,
  value,
  options,
  onChange,
}: {
  labelId: string;
  value: T;
  options: { value: T; label: string; hint?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`flex min-h-touch flex-1 basis-[120px] flex-col items-start justify-center rounded-sm border px-3 py-2 text-left text-sm leading-5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "border-accent bg-accent-soft font-medium text-text" : "border-border bg-surface-raised text-muted hover:text-text"}`}
          >
            {option.label}
            {option.hint && <small className="text-xs font-normal text-faint">{option.hint}</small>}
          </button>
        );
      })}
    </div>
  );
}
