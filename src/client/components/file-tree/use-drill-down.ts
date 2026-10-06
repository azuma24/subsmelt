import { useCallback, useEffect, useState } from "react";
import { deepestExistingPath, subtreeAt, type DrillNode } from "./drill-down";

export interface DrillDownState<T extends DrillNode> {
  /** "" = root (not drilled in). */
  path: string;
  /** Node currently drilled into, or null at root. */
  current: T | null;
  enter: (path: string) => void;
  jumpTo: (path: string) => void;
}

/**
 * Mobile drill-down navigation over a folder tree. Disabled (held at root) on
 * desktop; after a refresh, a vanished folder falls back to its deepest
 * surviving ancestor.
 */
export function useDrillDown<T extends DrillNode>(roots: readonly T[], enabled: boolean): DrillDownState<T> {
  const [path, setPath] = useState("");

  useEffect(() => {
    if (!enabled) setPath("");
  }, [enabled]);

  useEffect(() => {
    if (!path || roots.length === 0) return;
    const surviving = deepestExistingPath(roots as T[], path);
    if (surviving !== path) setPath(surviving);
  }, [roots, path]);

  const enter = useCallback((p: string) => setPath(p), []);
  const jumpTo = useCallback((p: string) => setPath(p), []);

  return { path, current: subtreeAt(roots as T[], path), enter, jumpTo };
}
