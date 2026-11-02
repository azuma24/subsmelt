import type { Job, TaskStatus } from "../../types";
import type { LibraryItem } from "./library-model";
import { getTaskStatus } from "./task-status";

/**
 * Library work that has no job yet, listed beside the jobs: a video with no
 * subtitle waits for a transcription, and a subtitle's target language that
 * was never queued (or whose job was cleared) waits for a translation.
 */
export type FileRow =
  | { kind: "untranscribed"; key: string; item: LibraryItem; name: string; path: string; folder: string }
  | {
      kind: "unqueued";
      key: string;
      item: LibraryItem;
      name: string;
      path: string;
      folder: string;
      task: TaskStatus;
    };

export function fileRows(items: LibraryItem[], jobsById: Map<number, Job>): FileRow[] {
  return items.flatMap((item): FileRow[] => {
    if (item.kind === "video" && item.file.subtitles.length === 0) {
      return [{ kind: "untranscribed", key: item.key, item, name: item.name, path: item.key, folder: item.folder }];
    }
    return item.file.subtitles.flatMap((subtitle) =>
      subtitle.tasks
        .filter((task) => getTaskStatus(task, jobsById) === "new")
        .map(
          (task): FileRow => ({
            kind: "unqueued",
            key: `${subtitle.srtPath}#${task.taskId}`,
            item,
            name: subtitle.srtName,
            path: subtitle.srtPath,
            folder: item.folder,
            task,
          }),
        ),
    );
  });
}

/** The row's entry in the target filter, in the form that filter uses for jobs; null without a target. */
export function fileRowTarget(row: FileRow): string | null {
  return row.kind === "unqueued" ? `${row.task.targetLang || row.task.langCode} (${row.task.langCode})` : null;
}

/**
 * The search box and folder filter, applied the way they apply to jobs. The
 * media root's own folder is "" here and `rootLabel` in the folder filter.
 */
export function fileRowMatches(row: FileRow, query: string, folder: string, rootLabel = ""): boolean {
  const needle = query.trim().toLowerCase();
  if (needle && !row.path.toLowerCase().includes(needle)) return false;
  return folder === "all" || (row.folder || rootLabel) === folder;
}
