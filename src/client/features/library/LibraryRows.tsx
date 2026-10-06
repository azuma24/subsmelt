import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { Job } from "../../types";
import { Icon } from "../../ui/Icon";
import { itemLanguageChips, type ClassifiedItem, type LibrarySection, type LibraryStatus } from "./library-model";
import { LanguageChip } from "./LanguageChip";

export const STATUS_DOT: Record<LibraryStatus, string> = {
  error: "bg-danger",
  needsTranscription: "bg-warning",
  missingLanguage: "bg-faint",
  inProgress: "bg-accent",
  done: "bg-success",
};

const CHECKBOX = "h-4 w-4 shrink-0 accent-accent";

interface SectionHeaderProps {
  section: LibrarySection;
  collapsed: boolean;
  checkedCount: number;
  onToggleCollapsed: (key: string) => void;
  onToggleChecked: (section: LibrarySection) => void;
}

export const SectionHeader = memo(function SectionHeader({
  section,
  collapsed,
  checkedCount,
  onToggleCollapsed,
  onToggleChecked,
}: SectionHeaderProps) {
  const { t } = useTranslation();
  const label =
    section.mode === "folder" ? section.key || t("library.folder.root") : t(`library.filter.${section.key}`);
  const allChecked = checkedCount === section.items.length;
  return (
    <div className="flex min-h-touch items-center gap-3 border-b border-border bg-surface-raised px-4">
      <input
        type="checkbox"
        className={CHECKBOX}
        checked={allChecked}
        ref={(el) => {
          if (el) el.indeterminate = checkedCount > 0 && !allChecked;
        }}
        onChange={() => onToggleChecked(section)}
        aria-label={t("library.folder.select", { folder: label })}
      />
      {section.mode === "folder" ? (
        <button
          type="button"
          onClick={() => onToggleCollapsed(section.key)}
          aria-expanded={!collapsed}
          aria-label={t("library.folder.toggle", { folder: label })}
          className="flex min-h-touch min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon name={collapsed ? "chevron-right" : "chevron-down"} className="text-muted" />
          <span className="min-w-0 break-words text-sm font-semibold text-text [overflow-wrap:anywhere]">{label}</span>
          <span className="shrink-0 text-xs text-muted">
            {t("library.summary.files", { count: section.items.length })}
          </span>
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATUS_DOT[section.key as LibraryStatus]}`} />
          <span className="text-sm font-semibold text-text">{label}</span>
          <span className="text-xs text-muted">{section.items.length}</span>
        </div>
      )}
    </div>
  );
});

interface ItemRowProps {
  entry: ClassifiedItem;
  mode: LibrarySection["mode"];
  jobsById: Map<number, Job>;
  checked: boolean;
  open: boolean;
  focusable: boolean;
  onToggleChecked: (key: string) => void;
  onOpen: (key: string) => void;
}

export const ItemRow = memo(function ItemRow({
  entry,
  mode,
  jobsById,
  checked,
  open,
  focusable,
  onToggleChecked,
  onOpen,
}: ItemRowProps) {
  const { t } = useTranslation();
  const { item } = entry;
  const tasks = itemLanguageChips(item, jobsById);
  const failed = tasks.filter(({ status }) => status === "error").map(({ task }) => task.langCode);
  const subtitleCount = item.file.subtitles.length;
  return (
    <div
      className={`relative flex items-start gap-3 border-b border-border px-4 transition-colors duration-fast ${open ? "bg-accent-soft" : "hover:bg-surface-raised"}`}
    >
      {open && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-accent" />}
      <input
        type="checkbox"
        className={`${CHECKBOX} mt-4`}
        checked={checked}
        onChange={() => onToggleChecked(item.key)}
        aria-label={t("library.row.select", { name: item.name })}
      />
      <button
        type="button"
        data-row-key={item.key}
        tabIndex={focusable ? 0 : -1}
        aria-current={open ? "true" : undefined}
        onClick={() => onOpen(item.key)}
        className="flex min-h-touch min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-left"
      >
        <Icon name={item.kind === "video" ? "video" : "subtitle"} className="text-muted" />
        <span className="min-w-0 flex-1 basis-60">
          <span className="block break-words text-sm font-medium text-text [overflow-wrap:anywhere]">{item.name}</span>
          <span className="flex flex-wrap gap-x-2 text-xs text-muted">
            {mode === "status" && (
              <span className="font-mono [overflow-wrap:anywhere]">{item.folder || t("library.folder.root")}</span>
            )}
            {item.kind === "subtitle" && <span>{t("library.row.orphan")}</span>}
            {item.kind === "video" && (
              <span>
                {subtitleCount === 0 ? t("library.row.noSubtitles") : t("app.subtitleCount", { count: subtitleCount })}
              </span>
            )}
            {failed.length > 0 && (
              <span className="text-danger">{t("library.row.failed", { langs: failed.join(", ") })}</span>
            )}
          </span>
        </span>
        {tasks.length > 0 && (
          <span className="flex flex-wrap justify-end gap-1">
            {tasks.map(({ task, status }) => (
              <LanguageChip key={task.taskId} task={task} status={status} />
            ))}
          </span>
        )}
      </button>
    </div>
  );
});

/** Placeholder rows shaped like real ones, shown until the scan preview arrives. */
export function LibraryRowsSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      <div className="flex min-h-touch items-center gap-3 border-b border-border bg-surface-raised px-4">
        <span className="h-4 w-4 rounded-sm bg-surface-highlight" />
        <span className="h-3 w-48 rounded-full bg-surface-highlight" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="h-4 w-4 rounded-sm bg-surface-highlight" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-2/3 animate-pulse rounded-full bg-surface-highlight motion-reduce:animate-none" />
            <span className="block h-2 w-1/4 rounded-full bg-surface-highlight" />
          </span>
          <span className="hidden gap-1 sm:flex">
            <span className="h-5 w-12 rounded-full bg-surface-highlight" />
            <span className="h-5 w-12 rounded-full bg-surface-highlight" />
          </span>
        </div>
      ))}
    </div>
  );
}
