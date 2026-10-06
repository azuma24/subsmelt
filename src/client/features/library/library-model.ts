import type { JobRow, ScannedFile, TaskStatus } from "../../types";
import { getTaskStatus } from "./task-status";

/**
 * Status groups, in precedence order: an item belongs to the first group that
 * matches. Groups that need the person to act come before groups that resolve
 * on their own, so a file with one failed and one queued language reads as an
 * error, and a file with one missing and one queued language reads as missing.
 * A subtitle no translation target applies to has no language to miss, so a
 * file whose subtitles all lack targets reads as done; its panel says why.
 * The status chips render in this order too.
 */
export const LIBRARY_STATUSES = ["error", "needsTranscription", "missingLanguage", "inProgress", "done"] as const;
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];
export type LibraryFilter = "all" | LibraryStatus;

/** What one target language of one subtitle looks like to the person. */
export type LanguageState = "done" | "missing" | "queued" | "translating" | "error";

/** Scan and job statuses → language state. "skipped" means the target file
 *  already exists (found on disk, or written by a sibling subtitle). */
const LANGUAGE_STATE: Record<string, LanguageState> = {
  done: "done",
  skipped: "done",
  new: "missing",
  pending: "queued",
  translating: "translating",
  error: "error",
};

export function languageState(status: string): LanguageState {
  return LANGUAGE_STATE[status] ?? "missing";
}

/** A video or an orphan subtitle, as the Library lists it. */
export interface LibraryItem {
  /** videoPath, or the subtitle path for an orphan subtitle. */
  key: string;
  kind: "video" | "subtitle";
  name: string;
  /** Folder relative to the media root; "" is the root itself. */
  folder: string;
  file: ScannedFile;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

export function relativeFolder(filePath: string, mediaDir: string): string {
  const path = normalize(filePath);
  const root = normalize(mediaDir).replace(/\/+$/, "");
  const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  if (dir === root) return "";
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir;
}

export function toLibraryItems(files: ScannedFile[], mediaDir: string): LibraryItem[] {
  return files.flatMap((file): LibraryItem[] => {
    const key = file.videoPath ?? file.subtitles[0]?.srtPath;
    if (!key) return [];
    return [{
      key,
      kind: file.videoPath ? "video" : "subtitle",
      name: file.videoName ?? file.subtitles[0].srtName,
      folder: relativeFolder(key, mediaDir),
      file,
    }];
  });
}

export function itemTasks(item: LibraryItem): TaskStatus[] {
  return item.file.subtitles.flatMap((sub) => sub.tasks);
}

// Which state a language shows when several source subtitles disagree: what is moving first, done last.
const CHIP_PRIORITY = ["translating", "pending", "error", "new", "done", "skipped"];
const chipRank = (status: string) => {
  const rank = CHIP_PRIORITY.indexOf(status);
  return rank === -1 ? CHIP_PRIORITY.indexOf("new") : rank;
};

/**
 * One chip per language. Every source subtitle of a video translates into the
 * same output, so a language listed once per source only repeats itself; the
 * chip shows its most pressing state across them.
 */
export function itemLanguageChips(item: LibraryItem, jobsById: Map<number, JobRow>): { task: TaskStatus; status: string }[] {
  const byTask = new Map<number, { task: TaskStatus; status: string }>();
  for (const task of itemTasks(item)) {
    const status = getTaskStatus(task, jobsById);
    const current = byTask.get(task.taskId);
    if (!current || chipRank(status) < chipRank(current.status)) byTask.set(task.taskId, { task, status });
  }
  return [...byTask.values()];
}

/** The one status group an item belongs to. Chips, counts, sections and rows all read this. */
export function itemStatus(item: LibraryItem, jobsById: Map<number, JobRow>): LibraryStatus {
  if (item.kind === "video" && item.file.subtitles.length === 0) return "needsTranscription";
  // The same per-language state the chips show, so the row's group, its dot and its chips agree.
  const states = new Set(itemLanguageChips(item, jobsById).map(({ status }) => languageState(status)));
  if (states.has("error")) return "error";
  if (states.has("missing")) return "missingLanguage";
  if (states.has("queued") || states.has("translating")) return "inProgress";
  return "done";
}

/** Job ids of this item's tasks whose live job is in `status`. */
export function itemJobIds(item: LibraryItem, jobsById: Map<number, JobRow>, status: string): number[] {
  return itemTasks(item)
    .filter((task) => task.jobId !== null && jobsById.get(task.jobId)?.status === status)
    .map((task) => task.jobId as number);
}

export function matchesQuery(item: LibraryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${item.folder}/${item.name}`.toLowerCase().includes(needle);
}

export interface ClassifiedItem {
  item: LibraryItem;
  status: LibraryStatus;
}

export interface LibrarySection {
  /** Folder path in folder mode, status in status mode. */
  key: string;
  mode: "folder" | "status";
  items: ClassifiedItem[];
}

export interface LibraryView {
  /** Counts over the searched set, so a chip's count always equals its list length. */
  counts: Record<LibraryFilter, number>;
  sections: LibrarySection[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byPath = (a: ClassifiedItem, b: ClassifiedItem) =>
  collator.compare(a.item.folder, b.item.folder) || collator.compare(a.item.name, b.item.name);

/** "All" groups by folder; any other filter flattens into that status's group. */
export function buildLibraryView(
  items: LibraryItem[],
  jobsById: Map<number, JobRow>,
  filter: LibraryFilter,
  query: string,
): LibraryView {
  const searched = items
    .filter((item) => matchesQuery(item, query))
    .map((item) => ({ item, status: itemStatus(item, jobsById) }))
    .sort(byPath);

  const counts = Object.fromEntries([["all", searched.length], ...LIBRARY_STATUSES.map((s) => [s, 0])]) as Record<LibraryFilter, number>;
  for (const entry of searched) counts[entry.status] += 1;

  if (filter !== "all") {
    const matching = searched.filter((entry) => entry.status === filter);
    return { counts, sections: matching.length > 0 ? [{ key: filter, mode: "status", items: matching }] : [] };
  }

  const byFolder = new Map<string, ClassifiedItem[]>();
  for (const entry of searched) {
    const list = byFolder.get(entry.item.folder) ?? [];
    list.push(entry);
    byFolder.set(entry.item.folder, list);
  }
  const sections = [...byFolder.entries()].map(([key, sectionItems]): LibrarySection => ({ key, mode: "folder", items: sectionItems }));
  return { counts, sections };
}

export type LibraryRow =
  | { type: "section"; section: LibrarySection; collapsed: boolean }
  | { type: "item"; entry: ClassifiedItem; mode: LibrarySection["mode"] };

/** The rendered row sequence: a header per section, then its items unless collapsed. */
export function flattenRows(sections: LibrarySection[], collapsed: ReadonlySet<string>): LibraryRow[] {
  return sections.flatMap((section): LibraryRow[] => {
    const isCollapsed = section.mode === "folder" && collapsed.has(section.key);
    const header: LibraryRow = { type: "section", section, collapsed: isCollapsed };
    if (isCollapsed) return [header];
    return [header, ...section.items.map((entry): LibraryRow => ({ type: "item", entry, mode: section.mode }))];
  });
}
