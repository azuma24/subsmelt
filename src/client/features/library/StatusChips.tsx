import { useTranslation } from "../../i18n";
import { LIBRARY_STATUSES, type LibraryFilter } from "./library-model";
import { STATUS_DOT } from "./LibraryRows";

const FILTERS: readonly LibraryFilter[] = ["all", ...LIBRARY_STATUSES];

interface StatusChipsProps {
  counts: Record<LibraryFilter, number>;
  active: LibraryFilter;
  onSelect: (filter: LibraryFilter) => void;
}

export function StatusChips({ counts, active, onSelect }: StatusChipsProps) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("library.filter.label")} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {FILTERS.map((filter) => {
        const selected = filter === active;
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(filter)}
            className={`inline-flex min-h-touch shrink-0 items-center gap-2 rounded-full border px-4 text-sm transition-colors duration-fast ${selected ? "border-text bg-text text-surface" : "border-border bg-surface text-text hover:bg-surface-raised"}`}
          >
            {filter !== "all" && <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATUS_DOT[filter]}`} />}
            {t(`library.filter.${filter}`)}
            <span className={`font-mono text-xs tabular-nums ${selected ? "text-surface" : "text-muted"}`}>
              {counts[filter]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
