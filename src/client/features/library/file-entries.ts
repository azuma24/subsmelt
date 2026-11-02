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
  if (folder !== "all" && (entry.item.folder || rootLabel) !== folder) return false;
  if (target === "all") return true;
  return entry.chips.some(({ task }) => targetLabel(task) === target);
}
