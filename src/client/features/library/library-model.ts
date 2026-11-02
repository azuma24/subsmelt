import type { Job, ScannedFile, TaskStatus } from "../../types";
import { getTaskStatus } from "./task-status";

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
    return [
      {
        key,
        kind: file.videoPath ? "video" : "subtitle",
        name: file.videoName ?? file.subtitles[0].srtName,
        folder: relativeFolder(key, mediaDir),
        file,
      },
    ];
  });
}

export function itemTasks(item: LibraryItem): TaskStatus[] {
  return item.file.subtitles.flatMap((sub) => sub.tasks);
}

// The job a person most likely wants when opening a file's jobs: what failed, then what is moving.
const JOB_RELEVANCE = ["error", "translating", "pending"];

/** The file's most relevant job (error, translating, pending, else the newest), or null when it has none. */
export function relevantJobId(item: LibraryItem, jobsById: Map<number, Job>): number | null {
  const jobs = itemTasks(item).flatMap((task) => {
    const job = task.jobId === null ? undefined : jobsById.get(task.jobId);
    return job ? [job] : [];
  });
  for (const status of JOB_RELEVANCE) {
    const match = jobs.find((job) => job.status === status);
    if (match) return match.id;
  }
  return jobs.length === 0 ? null : Math.max(...jobs.map((job) => job.id));
}

// Which state a language shows when several source subtitles disagree: what is moving first, done last.
const CHIP_PRIORITY = ["translating", "pending", "error", "new", "done", "skipped"];
const chipRank = (status: string) => {
  const rank = CHIP_PRIORITY.indexOf(status);
  return rank === -1 ? CHIP_PRIORITY.indexOf("new") : rank;
};

/**
 * One chip per target language of a file. Every source subtitle of a video
 * translates into the same output, so a language listed once per source only
 * repeats itself; the chip shows its most pressing state across them.
 */
export function itemLanguageChips(
  item: LibraryItem,
  jobsById: Map<number, Job>,
): { task: TaskStatus; status: string }[] {
  const byTask = new Map<number, { task: TaskStatus; status: string }>();
  for (const task of itemTasks(item)) {
    const status = getTaskStatus(task, jobsById);
    const current = byTask.get(task.taskId);
    if (!current || chipRank(status) < chipRank(current.status)) byTask.set(task.taskId, { task, status });
  }
  return [...byTask.values()];
}
