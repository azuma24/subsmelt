/**
 * Generic path→tree builder shared by every panel that renders a file tree.
 * Panels differ in file shape and sort rules, so both come in via options;
 * the folder nesting, aggregation and ordering logic lives here once.
 */

export const DEFAULT_PATH_MARKER = "/media/";

export interface PathTreeNode<F> {
  name: string;
  /** Folder path relative to the marker, e.g. "movies/2024". "" is the root. */
  path: string;
  children: PathTreeNode<F>[];
  /** Files directly in this folder. */
  files: F[];
  /** Every file under this node, recursive, in render order. */
  allFiles: F[];
  /** pathOf() of every file under this node, recursive, in render order. */
  allPaths: string[];
}

export interface BuildPathTreeOptions<F> {
  /** Absolute path used to place the file in the tree. */
  pathOf: (file: F) => string;
  /** Prefix that separates the library root from relative segments. */
  marker?: string;
  compareFiles: (a: F, b: F) => number;
  /** Compares sibling folder names. */
  compareFolders: (a: string, b: string) => number;
}

/** Path segments relative to the marker; falls back to the whole path when absent. */
function relSegments(path: string, marker: string): string[] {
  const idx = path.indexOf(marker);
  const rest = idx >= 0 ? path.slice(idx + marker.length) : path.replace(/^\/+/, "");
  return rest.split(/[\\/]/).filter(Boolean);
}

/** "…/media/a/b/f.mp4" → "a/b/f.mp4" for flat filtered lists. */
export function relativeDisplayPath(path: string, marker: string = DEFAULT_PATH_MARKER): string {
  return relSegments(path, marker).join("/");
}

export function buildPathTree<F>(files: readonly F[], options: BuildPathTreeOptions<F>): PathTreeNode<F> {
  const { pathOf, marker = DEFAULT_PATH_MARKER, compareFiles, compareFolders } = options;
  const root: PathTreeNode<F> = { name: "", path: "", children: [], files: [], allFiles: [], allPaths: [] };
  const byPath = new Map<string, PathTreeNode<F>>([["", root]]);

  for (const f of files) {
    const segs = relSegments(pathOf(f), marker);
    const dirs = segs.slice(0, -1);
    let node = root;
    let acc = "";
    for (const dir of dirs) {
      acc = acc ? `${acc}/${dir}` : dir;
      let child = byPath.get(acc);
      if (!child) {
        child = { name: dir, path: acc, children: [], files: [], allFiles: [], allPaths: [] };
        byPath.set(acc, child);
        node.children.push(child);
      }
      node = child;
    }
    node.files.push(f);
  }

  const fill = (n: PathTreeNode<F>): F[] => {
    n.children.sort((a, b) => compareFolders(a.name, b.name));
    n.files.sort(compareFiles);
    n.allFiles = [...n.files, ...n.children.flatMap(fill)];
    n.allPaths = n.allFiles.map(pathOf);
    return n.allFiles;
  };
  fill(root);
  return root;
}

/** Folder paths of every node in the tree (excluding the virtual root). */
export function collectFolderPaths<F>(roots: readonly PathTreeNode<F>[]): string[] {
  return roots.flatMap((n) => [n.path, ...collectFolderPaths(n.children)]);
}
