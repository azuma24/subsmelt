/**
 * Whether a row's folder is in the selected folder. Rows carry their folder as
 * a media-relative label ("AnKor/Tutorials"), or a stand-in label for the media
 * root and for files outside it. A real folder takes its subfolders with it,
 * so picking "AnKor" in the folder sidebar shows AnKor/Tutorials too; a
 * stand-in label matches only itself.
 */
export function folderInScope(label: string, filter: string, ...standIns: string[]): boolean {
  if (filter === "" || label === filter) return true;
  if (standIns.includes(filter)) return false;
  return label.startsWith(`${filter}/`);
}

/** "AnKor/Tutorials/2024" → ["AnKor", "AnKor/Tutorials", "AnKor/Tutorials/2024"], for a breadcrumb. */
export function folderTrail(folder: string): string[] {
  const parts = folder.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export interface FolderStats {
  /** Library files (one per video, or per subtitle with no video), subfolders included. */
  files: number;
  done: number;
  /** Pending or translating. */
  waiting: number;
  errors: number;
}

const emptyStats = (): FolderStats => ({ files: 0, done: 0, waiting: 0, errors: 0 });

/**
 * Per-folder totals, each folder counting its subfolders, keyed by
 * media-relative path ("" is the whole library). Built from the same Library
 * items and jobs the list shows, so the sidebar and the rows always agree.
 * `folder` is null for a job outside the media folder, which counts nowhere.
 */
export function folderStats(
  items: ReadonlyArray<{ folder: string }>,
  jobs: ReadonlyArray<{ status: string; folder: string | null }>,
): Map<string, FolderStats> {
  const stats = new Map<string, FolderStats>();
  const bump = (folder: string, key: keyof FolderStats) => {
    for (const path of ["", ...folderTrail(folder)]) {
      const entry = stats.get(path) ?? emptyStats();
      entry[key]++;
      stats.set(path, entry);
    }
  };
  for (const item of items) bump(item.folder, "files");
  for (const job of jobs) {
    if (job.folder === null) continue;
    if (job.status === "done") bump(job.folder, "done");
    else if (job.status === "error") bump(job.folder, "errors");
    else if (job.status === "pending" || job.status === "translating") bump(job.folder, "waiting");
  }
  return stats;
}

export function statsFor(stats: ReadonlyMap<string, FolderStats>, folder: string): FolderStats {
  return stats.get(folder) ?? emptyStats();
}
