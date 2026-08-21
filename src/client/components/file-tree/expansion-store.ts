/**
 * Persisted expand/collapse state for file trees, one localStorage entry per
 * tree (`fileTree.expanded.<treeId>`), stored as a JSON array of folder paths.
 * Absence from the set means collapsed, so never-seen folders default closed.
 * All storage access is wrapped: a denied or corrupt store degrades to the
 * empty set instead of breaking the tree.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_PREFIX = "fileTree.expanded";

export function expansionStorageKey(treeId: string): string {
  return `${KEY_PREFIX}.${treeId}`;
}

export function loadExpanded(storage: KeyValueStorage, treeId: string): Set<string> {
  try {
    const raw = storage.getItem(expansionStorageKey(treeId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

export function saveExpanded(storage: KeyValueStorage, treeId: string, expanded: ReadonlySet<string>): void {
  try {
    storage.setItem(expansionStorageKey(treeId), JSON.stringify(Array.from(expanded)));
  } catch {
    // Storage unavailable (private mode, quota) — expansion just won't persist.
  }
}

/**
 * Drop persisted paths whose folder no longer exists. Returns the input set
 * unchanged (same reference) when nothing was pruned, so React state updates
 * and re-saves can be skipped.
 */
export function pruneExpanded(expanded: Set<string>, livePaths: ReadonlySet<string>): Set<string> {
  const kept = Array.from(expanded).filter((p) => livePaths.has(p));
  return kept.length === expanded.size ? expanded : new Set(kept);
}
