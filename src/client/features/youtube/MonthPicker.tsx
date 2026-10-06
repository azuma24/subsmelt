import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { monthLabel } from "./format";

export interface YearMonth {
  year: number;
  /** 1 to 12. */
  month: number;
}

export const monthKey = ({ year, month }: YearMonth) => `${year}-${String(month).padStart(2, "0")}`;

/** A year and month picker: year arrows, twelve month buttons with post counts, nothing after this month. */
export function MonthPicker({ value, onChange, counts, today }: { value: YearMonth; onChange: (v: YearMonth) => void; counts: Map<string, number>; today: YearMonth }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(value.year);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const shortMonth = new Intl.DateTimeFormat(i18n.language, { month: "short", timeZone: "UTC" });

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[data-selected="true"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const toggle = () => {
    setViewYear(value.year);
    setOpen((o) => !o);
  };
  const choose = (month: number) => {
    onChange({ year: viewYear, month });
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        className="flex min-h-touch items-center gap-2 rounded-sm border border-border bg-surface-raised px-3 text-sm text-text hover:border-accent-line"
      >
        {monthLabel(monthKey(value), i18n.language)}
        <span aria-hidden="true" className="text-faint">▾</span>
      </button>
      {open && (
        <div role="dialog" aria-label={t("youtube.dialog.chooseMonth")} className="absolute left-0 top-[calc(100%+4px)] z-20 w-[288px] rounded-md border border-border bg-surface p-3 shadow-2">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" aria-label={t("youtube.dialog.prevYear")} onClick={() => setViewYear((y) => y - 1)} className="flex h-11 w-11 items-center justify-center rounded-sm text-muted hover:bg-surface-raised">‹</button>
            <b className="tabular-nums text-sm text-text">{viewYear}</b>
            <button type="button" aria-label={t("youtube.dialog.nextYear")} disabled={viewYear >= today.year} onClick={() => setViewYear((y) => y + 1)} className="flex h-11 w-11 items-center justify-center rounded-sm text-muted hover:bg-surface-raised disabled:opacity-40">›</button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
              const future = viewYear > today.year || (viewYear === today.year && month > today.month);
              const selected = viewYear === value.year && month === value.month;
              const n = counts.get(monthKey({ year: viewYear, month })) ?? 0;
              return (
                <button
                  key={month}
                  type="button"
                  disabled={future}
                  aria-pressed={selected}
                  data-selected={selected}
                  aria-label={t("youtube.dialog.monthVideos", { month: monthLabel(monthKey({ year: viewYear, month }), i18n.language), count: n })}
                  onClick={() => choose(month)}
                  className={`flex min-h-touch flex-col items-center justify-center rounded-sm border text-xs leading-4 disabled:cursor-not-allowed disabled:opacity-35 ${selected ? "border-accent bg-accent-soft text-text" : "border-transparent text-muted hover:bg-surface-raised"}`}
                >
                  {shortMonth.format(Date.UTC(viewYear, month - 1, 1))}
                  {!future && <small className="text-xs tabular-nums text-faint">{n}</small>}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-faint">{t("youtube.dialog.monthFootnote")}</p>
        </div>
      )}
    </div>
  );
}
