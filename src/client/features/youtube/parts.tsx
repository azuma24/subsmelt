import type { ReactNode } from "react";

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full border border-[var(--border)] px-2 text-[11px] leading-5 text-[var(--text-2)]">
      {children}
    </span>
  );
}

export type CountTone = "ok" | "run" | "bad" | "neutral";

const COUNT_TONE: Record<CountTone, string> = {
  ok: "border-[var(--green-border)] text-[var(--green)]",
  run: "border-[var(--accent-border)] text-[var(--accent)]",
  bad: "border-[var(--red-border)] text-[var(--red)]",
  neutral: "border-[var(--border)] text-[var(--text-2)]",
};

export function CountChip({ n, label, tone = "neutral" }: { n: number; label: string; tone?: CountTone }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[12px] leading-6 ${COUNT_TONE[tone]}`}>
      <b className="font-semibold tabular-nums">{n}</b> {label}
    </span>
  );
}

export type BannerTone = "warn" | "bad" | "info";

const BANNER_TONE: Record<BannerTone, { box: string; glyph: string }> = {
  warn: { box: "border-[var(--yellow-border)] bg-[var(--yellow-dim)] text-[var(--yellow)]", glyph: "!" },
  bad: { box: "border-[var(--red-border)] bg-[var(--red-dim)] text-[var(--red)]", glyph: "✕" },
  info: { box: "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]", glyph: "i" },
};

export function Banner({ tone, title, children }: { tone: BannerTone; title: string; children?: ReactNode }) {
  const style = BANNER_TONE[tone];
  return (
    <div role={tone === "info" ? "status" : "alert"} className={`flex flex-wrap items-start gap-3 rounded-xl border px-3.5 py-2.5 ${style.box}`}>
      <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-[11px] font-semibold">
        {style.glyph}
      </span>
      <p className="min-w-0 flex-1 text-[13px] leading-6 text-[var(--text)]">
        <strong className="font-semibold">{title}</strong>
        {children && <> {children}</>}
      </p>
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
    <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`flex min-h-[44px] flex-1 basis-[120px] flex-col items-start justify-center rounded-lg border px-3 py-1.5 text-left text-[13px] leading-5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "border-[var(--accent)] bg-[var(--accent-dim)] font-medium text-[var(--text)]" : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)]"}`}
          >
            {option.label}
            {option.hint && <small className="text-[11.5px] font-normal text-[var(--text-3)]">{option.hint}</small>}
          </button>
        );
      })}
    </div>
  );
}
