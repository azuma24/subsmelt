import { useCallback, useEffect, useMemo, useState } from "react";
import { loadExpanded, pruneExpanded, saveExpanded, type KeyValueStorage } from "./expansion-store";

function getBrowserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // storage access itself can throw (privacy settings)
  }
}

export interface TreeExpansion {
  expanded: ReadonlySet<string>;
  toggleExpand: (path: string) => void;
}

/**
 * Expand/collapse state persisted per tree in localStorage. Folders default to
 * collapsed; persisted paths that vanish from `livePaths` are pruned silently.
 * Pruning is skipped while `livePaths` is empty so a refetch-in-flight (or an
 * errored scan) can't wipe the stored state.
 */
export function usePersistedExpansion(treeId: string, livePaths: readonly string[]): TreeExpansion {
  const storage = useMemo(getBrowserStorage, []);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    storage ? loadExpanded(storage, treeId) : new Set(),
  );

  useEffect(() => {
    if (livePaths.length === 0) return;
    setExpanded((prev) => {
      const next = pruneExpanded(prev, new Set(livePaths));
      if (next !== prev && storage) saveExpanded(storage, treeId, next);
      return next;
    });
  }, [livePaths, storage, treeId]);

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      if (storage) saveExpanded(storage, treeId, next);
      return next;
    });
  }, [storage, treeId]);

  return { expanded, toggleExpand };
}
