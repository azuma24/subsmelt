import type { ScannedFile } from "../../types";

export type SortBy = "name" | "date";
export type SortDir = "asc" | "desc";

export interface TreeNode {
  name: string;
  path: string;          // folder path key (relative)
  children: TreeNode[];
  files: ScannedFile[];  // files directly in this folder
  allPaths: string[];    // every videoPath under this node (recursive)
}

// Split a videoPath into folder segments + filename, relative to the media root.
function relSegments(videoPath: string): string[] {
  const marker = "/media/";
  const idx = videoPath.indexOf(marker);
  const rest = idx >= 0 ? videoPath.slice(idx + marker.length) : videoPath.replace(/^\/+/, "");
  return rest.split(/[\\/]/).filter(Boolean);
}

export function buildFolderTree(files: ScannedFile[], sortBy: SortBy, sortDir: SortDir): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], files: [], allPaths: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  for (const f of files) {
    const segs = relSegments(f.videoPath as string);
    const dirs = segs.slice(0, -1);
    let node = root;
    let acc = "";
    for (const dir of dirs) {
      acc = acc ? `${acc}/${dir}` : dir;
      let child = byPath.get(acc);
      if (!child) {
        child = { name: dir, path: acc, children: [], files: [], allPaths: [] };
        byPath.set(acc, child);
        node.children.push(child);
      }
      node = child;
    }
    node.files.push(f);
  }
  const dirMul = sortDir === "asc" ? 1 : -1;
  const fill = (n: TreeNode): string[] => {
    // Folders sort by name only (no single mtime); direction still applies so
    // the whole tree flips consistently when the user toggles asc/desc.
    n.children.sort((a, b) => a.name.localeCompare(b.name) * dirMul);
    // Files sort by the chosen key; nulls for date are placed last regardless of direction.
    n.files.sort((a, b) => {
      if (sortBy === "date") {
        const am = a.videoMtime ?? null;
        const bm = b.videoMtime ?? null;
        if (am === null && bm === null) return 0;
        if (am === null) return 1;
        if (bm === null) return -1;
        return (am - bm) * dirMul;
      }
      return (a.videoName || "").localeCompare(b.videoName || "") * dirMul;
    });
    const own = n.files.map((f) => f.videoPath as string);
    const kids = n.children.flatMap(fill);
    n.allPaths = [...own, ...kids];
    return n.allPaths;
  };
  fill(root);
  return root;
}
