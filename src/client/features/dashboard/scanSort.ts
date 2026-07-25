import type { ScannedFile } from "../../types";

export type DashboardSortBy = "name" | "date";
export type DashboardSortDir = "asc" | "desc";
export type ScanGroup = [name: string, files: ScannedFile[]];

export function validDashboardSortBy(value: unknown): DashboardSortBy {
  return value === "name" || value === "date" ? value : "date";
}

export function validDashboardSortDir(value: unknown): DashboardSortDir {
  return value === "asc" || value === "desc" ? value : "desc";
}

function compareNullableMtime(a: number | null, b: number | null, direction: DashboardSortDir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * (direction === "asc" ? 1 : -1);
}

/** The folder's date is the newest known file date beneath it. */
export function latestFileMtime(files: ScannedFile[]): number | null {
  return files.reduce<number | null>((latest, file) => {
    const mtime = file.videoMtime;
    if (mtime === null) return latest;
    return latest === null ? mtime : Math.max(latest, mtime);
  }, null);
}

export function sortScanFiles(files: ScannedFile[], sortBy: DashboardSortBy, sortDir: DashboardSortDir): ScannedFile[] {
  return [...files].sort((a, b) => {
    if (sortBy === "date") {
      const byDate = compareNullableMtime(a.videoMtime, b.videoMtime, sortDir);
      if (byDate !== 0) return byDate;
    }
    return (a.videoName || "").localeCompare(b.videoName || "") * (sortDir === "asc" ? 1 : -1);
  });
}

export function sortScanGroups(groups: ScanGroup[], sortBy: DashboardSortBy, sortDir: DashboardSortDir): ScanGroup[] {
  return [...groups].sort(([nameA, filesA], [nameB, filesB]) => {
    if (sortBy === "date") {
      const byDate = compareNullableMtime(latestFileMtime(filesA), latestFileMtime(filesB), sortDir);
      if (byDate !== 0) return byDate;
    }
    return nameA.localeCompare(nameB) * (sortDir === "asc" ? 1 : -1);
  });
}
