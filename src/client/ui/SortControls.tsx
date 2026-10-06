import { useTranslation } from "react-i18next";
import { ActionButton } from "./primitives";
import { Icon } from "./Icon";

export type SortBy = "name" | "date";
export type SortDir = "asc" | "desc";

/** Form-control styling for selects; re-exported by whisper-shared. */
export const selectCls =
  "rounded-sm border border-border bg-surface px-3 py-2 text-xs text-text min-h-touch md:min-h-0";

export interface SortControlsProps {
  sortBy: SortBy;
  sortDir: SortDir;
  onSortByChange: (value: SortBy) => void;
  onToggleSortDir: () => void;
}

/**
 * The name/date sort pair shared by the Library and the Transcribe picker: a
 * labelled select and a direction toggle. Both surfaces write the choice
 * through to the same settings keys, so the preference follows the person.
 */
export function SortControls({ sortBy, sortDir, onSortByChange, onToggleSortDir }: SortControlsProps) {
  const { t } = useTranslation();
  return (
    <>
      <select
        aria-label={t("whisper.sortAriaLabel")}
        value={sortBy}
        onChange={(event) => onSortByChange(event.target.value as SortBy)}
        className={selectCls}
      >
        <option value="name">{t("whisper.sortByName")}</option>
        <option value="date">{t("whisper.sortByDate")}</option>
      </select>
      <ActionButton variant="ghost" size="sm" onClick={onToggleSortDir}>
        <Icon name={sortDir === "asc" ? "arrow-up" : "arrow-down"} />
        <span className="sr-only">{sortDir === "asc" ? t("whisper.sortAsc") : t("whisper.sortDesc")}</span>
      </ActionButton>
    </>
  );
}
