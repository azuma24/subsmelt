import type { ScannedFile } from "../../types";
import { buildPathTree, type PathTreeNode } from "../../components/file-tree/build";

export type SortBy = "name" | "date";
export type SortDir = "asc" | "desc";

export type TreeNode = PathTreeNode<ScannedFile>;

export function buildFolderTree(files: ScannedFile[], sortBy: SortBy, sortDir: SortDir): TreeNode {
  const dirMul = sortDir === "asc" ? 1 : -1;
  return buildPathTree(files, {
    pathOf: (f) => f.videoPath as string,
    // Folders sort by name only (no single mtime); direction still applies so
    // the whole tree flips consistently when the user toggles asc/desc.
    compareFolders: (a, b) => a.localeCompare(b) * dirMul,
    // Files sort by the chosen key; nulls for date are placed last regardless of direction.
    compareFiles: (a, b) => {
      if (sortBy === "date") {
        const am = a.videoMtime ?? null;
        const bm = b.videoMtime ?? null;
        if (am === null && bm === null) return 0;
        if (am === null) return 1;
        if (bm === null) return -1;
        return (am - bm) * dirMul;
      }
      return (a.videoName || "").localeCompare(b.videoName || "") * dirMul;
    },
  });
}
