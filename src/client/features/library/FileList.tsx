import { useTranslation } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { EmptyHint } from "../../ui/primitives";
import type { FileEntry } from "./file-entries";
import { LanguageChip } from "./LanguageChip";

interface FileListProps {
  entries: FileEntry[];
  rootLabel: string;
  onOpen: (key: string) => void;
  disabled?: boolean;
  pendingReviewsByPath?: ReadonlyMap<string, string>;
}

/** One row per Library file: its name, folder and a chip per target language. */
export function FileList({ entries, rootLabel, onOpen, disabled, pendingReviewsByPath }: FileListProps) {
  const { t } = useTranslation();
  if (entries.length === 0) {
    return (
      <div className="p-4">
        <EmptyHint text={t("dashboard.noJobsMatchFilter")} />
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border-subtle">
      {entries.map((entry) => (
        <li key={entry.item.key}>
          <FileSummary
            entry={entry}
            rootLabel={rootLabel}
            onOpen={onOpen}
            disabled={disabled}
            needsReview={entry.item.kind === "video" && pendingReviewsByPath?.has(entry.item.key)}
          />
        </li>
      ))}
    </ul>
  );
}

/** A file's name, folder and language chips, as one button that opens its panel. */
export function FileSummary({
  entry: { item, chips },
  rootLabel,
  onOpen,
  className = "",
  disabled = false,
  needsReview = false,
}: {
  entry: FileEntry;
  rootLabel: string;
  onOpen: (key: string) => void;
  className?: string;
  disabled?: boolean;
  needsReview?: boolean;
}) {
  const { t } = useTranslation();
  const bare = item.kind === "video" && item.file.subtitles.length === 0;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onOpen(item.key)}
      title={item.key}
      className={`flex min-h-touch w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-surface-raised ${className}`}
    >
      <Icon name={item.kind === "video" ? "video" : "subtitle"} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">{item.name}</span>
        <span className="block truncate text-xs text-muted">{item.folder || rootLabel}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1">
        {needsReview && <span className="text-xs font-medium text-warning">{t("processing.pendingReview")}</span>}
        {bare && !needsReview && <span className="text-xs text-warning">{t("library.row.noSubtitles")}</span>}
        {!bare && chips.map(({ task, status }) => <LanguageChip key={task.taskId} task={task} status={status} />)}
      </span>
    </button>
  );
}
