import { memo } from "react";
import { useTranslation } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { MiniBtn, RowActionsMenu, StatusBadge, type StatusDescriptor } from "../../ui/primitives";
import type { TFunction } from "../../i18n";
import { GRID_COLS, TD } from "../dashboard/JobsTableDesktop";
import type { FileRow } from "./file-rows";

/** What the person can do with a file row; Transcribe is absent while transcription is off. */
export interface FileRowActions {
  onOpen: (row: FileRow) => void;
  onTranscribe?: (row: FileRow) => void;
  onTranslate: (row: FileRow) => void;
  /** Opens the file's panel with its "Translate to…" form, to pick any language. */
  onTranslateTo: (row: FileRow) => void;
}

function rowStatus(row: FileRow, t: TFunction): StatusDescriptor {
  return row.kind === "untranscribed"
    ? { glyph: { icon: "video" }, label: t("library.row.noSubtitles"), tone: "warn" }
    : { glyph: { icon: "new" }, label: t("library.row.notQueued"), tone: "neutral" };
}

function RowAction({ row, actions }: { row: FileRow; actions: FileRowActions }) {
  const { t } = useTranslation();
  if (row.kind === "unqueued") {
    return (
      <div className="flex items-center gap-2">
        <MiniBtn onClick={() => actions.onTranslate(row)}>{t("scan.translateFile.submit")}</MiniBtn>
        <RowActionsMenu
          items={[{ label: t("library.panel.translateTo"), onClick: () => actions.onTranslateTo(row) }]}
        />
      </div>
    );
  }
  const { onTranscribe } = actions;
  return onTranscribe ? (
    <MiniBtn tone="warning" onClick={() => onTranscribe(row)}>
      {t("scan.transcription.transcribe")}
    </MiniBtn>
  ) : null;
}

/** The file name, as the button that opens the file's panel. */
function FileName({ row, onOpen }: { row: FileRow; onOpen: (row: FileRow) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      title={row.path}
      className="flex min-w-0 items-center gap-2 text-left hover:underline"
    >
      <Icon name={row.kind === "untranscribed" ? "video" : "subtitle"} className="shrink-0 text-faint" />
      <span className="truncate text-sm font-medium text-text">{row.name}</span>
    </button>
  );
}

/** A file row on the jobs table's grid: no job yet, so no progress or time. */
export const FileRowDesktop = memo(function FileRowDesktop({
  row,
  actions,
}: {
  row: FileRow;
  actions: FileRowActions;
}) {
  const { t } = useTranslation();
  return (
    <div role="row" className="grid items-stretch hover:bg-surface-raised" style={{ gridTemplateColumns: GRID_COLS }}>
      <div className={TD} role="cell" />
      <div className={`${TD} flex min-w-0 items-center`} role="cell">
        <FileName row={row} onOpen={actions.onOpen} />
      </div>
      <div className={`${TD} text-xs text-faint`} role="cell">
        {row.kind === "unqueued" ? `${row.task.targetLang} · ${row.task.langCode}` : ""}
      </div>
      <div className={TD} role="cell">
        <StatusBadge status={rowStatus(row, t)} />
      </div>
      <div className={TD} role="cell" />
      <div className={TD} role="cell" />
      <div className={`${TD} flex items-center`} role="cell">
        <RowAction row={row} actions={actions} />
      </div>
    </div>
  );
});

/** The same row as a phone card. */
export const FileCardMobile = memo(function FileCardMobile({
  row,
  actions,
}: {
  row: FileRow;
  actions: FileRowActions;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <FileName row={row} onOpen={actions.onOpen} />
          {row.kind === "unqueued" && (
            <div className="mt-1 text-xs text-muted">
              {row.task.targetLang} · {row.task.langCode}
            </div>
          )}
        </div>
        <StatusBadge status={rowStatus(row, t)} />
      </div>
      <div className="mt-2 flex justify-end">
        <RowAction row={row} actions={actions} />
      </div>
    </div>
  );
});
