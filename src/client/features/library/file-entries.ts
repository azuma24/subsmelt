import { folderInScope } from "./folder-scope";
import type { Job, TaskStatus } from "../../types";
import type { JobStatusFilter } from "./dashboard-params";
import { itemLanguageChips, languageState, type LibraryItem } from "./library-model";

/** A Library file with its one-chip-per-language summary. */
export interface FileEntry {
  item: LibraryItem;
  chips: { task: TaskStatus; status: string }[];
}

export function fileEntries(items: LibraryItem[], jobsById: Map<number, Job>): FileEntry[] {
  return items.map((item) => ({ item, chips: itemLanguageChips(item, jobsById) }));
}

/**
 * Whether a file belongs under a status filter: it needs a transcription, has a
 * language never queued, or has a language whose job is in that status.
 */
export function fileMatchesStatus(entry: FileEntry, status: JobStatusFilter): boolean {
  if (status === "all") return true;
  if (status === "needsTranscription") return entry.item.kind === "video" && entry.item.file.subtitles.length === 0;
  if (status === "notQueued") return entry.chips.some(({ status: s }) => languageState(s) === "missing");
  // Done includes a language the scan found already translated on disk ("skipped").
  if (status === "done") return entry.chips.some(({ status: s }) => languageState(s) === "done");
  return entry.chips.some(({ status: s }) => s === status);
}

const targetLabel = (task: TaskStatus) => `${task.targetLang || task.langCode} (${task.langCode})`;

/** Folder and language dropdown entries covering every file, not only those with jobs. */
export function fileFilterOptions(entries: FileEntry[], rootLabel: string): { folders: string[]; targets: string[] } {
  const sorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return {
    folders: sorted(entries.map((entry) => entry.item.folder || rootLabel)),
    targets: sorted(entries.flatMap((entry) => entry.chips.map(({ task }) => targetLabel(task)))),
  };
}

/** The search box, folder and language filters, applied to a file. */
export function fileMatchesFilters(
  entry: FileEntry,
  query: string,
  folder: string,
  target: string,
  rootLabel: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle && !entry.item.key.toLowerCase().includes(needle)) return false;
  if (!folderInScope(entry.item.folder || rootLabel, folder, rootLabel)) return false;
  if (target === "all") return true;
  return entry.chips.some(({ task }) => targetLabel(task) === target);
}

export type FileSort = "name-asc" | "name-desc" | "date-desc" | "date-asc";

/** Sort a copy globally, with unknown dates last and stable name/path ties. */
export function sortFileEntries(entries: FileEntry[], sort: FileSort): FileEntry[] {
  const compareText = (a: string, b: string) => a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0);
  const namePath = (a: FileEntry, b: FileEntry) =>
    compareText(a.item.name, b.item.name) || compareText(a.item.key, b.item.key);
  return [...entries].sort((a, b) => {
    if (sort.startsWith("date")) {
      const time = (entry: FileEntry) => {
        const value = entry.item.kind === "video" ? entry.item.file.videoMtime : entry.item.file.subtitleMtime;
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      };
      const at = time(a);
      const bt = time(b);
      if (at === null || bt === null) return at === bt ? namePath(a, b) : at === null ? 1 : -1;
      return (sort === "date-asc" ? at - bt : bt - at) || namePath(a, b);
    }
    const names = compareText(a.item.name, b.item.name);
    return (sort === "name-desc" ? -names : names) || compareText(a.item.key, b.item.key);
  });
}
