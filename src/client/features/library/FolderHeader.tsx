import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { useSettingsQuery } from "../../hooks";
import type { FolderNode } from "../../types";
import { Icon } from "../../ui/Icon";
import { parseCorrectionRuleSets } from "../../../shared/corrections";
import { listsForFolder } from "../corrections/model";
import { folderTrail } from "./folder-scope";
import { fileCount } from "./FolderSidebar";

/**
 * Above the list while one folder is shown: where it is (a breadcrumb back up
 * to the whole library), what is in it, and the correction lists that apply.
 * The toolbar's bulk actions already act on the folder's rows.
 */
export function FolderHeader({
  folder,
  node,
  onSelect,
  onOpenTree,
}: {
  folder: string;
  node: FolderNode | undefined;
  onSelect: (folder: string) => void;
  /** Phones: opens the folder tree, which has no sidebar there. */
  onOpenTree?: () => void;
}) {
  const { t } = useTranslation();
  const settings = useSettingsQuery().data as Record<string, unknown> | undefined;
  const lists = useMemo(
    () =>
      listsForFolder(parseCorrectionRuleSets(String(settings?.correction_rule_sets ?? "[]")), folder).filter(
        (row) => row.list.enabled && (row.direct || row.inheritedFrom !== null),
      ),
    [settings, folder],
  );
  const trail = folderTrail(folder);
  const counts = node?.counts;

  return (
    <div className="shrink-0 space-y-1 border-b border-border px-4 py-2">
      <div className="flex flex-wrap items-center gap-1 text-sm">
        {onOpenTree && (
          <button
            type="button"
            onClick={onOpenTree}
            className="mr-1 inline-flex min-h-touch items-center gap-1 rounded-sm border border-border px-2 text-xs text-muted hover:text-text"
          >
            <Icon name="folder" size={16} />
            {t("library.folders.title")}
          </button>
        )}
        <nav aria-label={t("library.folders.breadcrumb")} className="flex min-w-0 flex-wrap items-center gap-1">
          <button type="button" onClick={() => onSelect("all")} className="text-muted hover:text-text hover:underline">
            {t("library.folders.all")}
          </button>
          {trail.map((path, i) => (
            <span key={path} className="flex min-w-0 items-center gap-1">
              <Icon name="chevron-right" size={16} className="text-faint" />
              {i === trail.length - 1 ? (
                <span aria-current="page" className="truncate font-medium text-text">
                  {path.split("/").pop()}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(path)}
                  className="truncate text-muted hover:text-text hover:underline"
                >
                  {path.split("/").pop()}
                </button>
              )}
            </span>
          ))}
        </nav>
      </div>
      {counts && (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          <span>{t("library.folders.files", { count: fileCount(counts) })}</span>
          {counts.completeJobs > 0 && (
            <span className="text-success">{t("library.folders.done", { count: counts.completeJobs })}</span>
          )}
          {counts.pendingJobs > 0 && <span>{t("library.folders.pending", { count: counts.pendingJobs })}</span>}
          {counts.errorJobs > 0 && (
            <span className="text-danger">{t("library.folders.errors", { count: counts.errorJobs })}</span>
          )}
        </p>
      )}
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{t("library.corrections.title")}:</span>
        {lists.length === 0 ? (
          <span className="text-faint">{t("library.folders.noCorrections")}</span>
        ) : (
          lists.map(({ list, inheritedFrom }) => (
            <span key={list.id} className="rounded-full border border-border px-2 py-0.5">
              {list.name || t("settings.corrections.untitled")}
              {inheritedFrom !== null &&
                ` · ${t("library.corrections.from", {
                  folder: inheritedFrom === "" ? t("settings.corrections.wholeLibrary") : inheritedFrom,
                })}`}
            </span>
          ))
        )}
        <Link to="/settings?section=corrections" className="text-accent hover:underline">
          {t("library.corrections.edit")}
        </Link>
      </p>
    </div>
  );
}
