/** Pure lookup helpers for mobile drill-down navigation. */

export interface DrillNode {
  path: string;
  children: DrillNode[];
}

/** Find the node at `path`, or null when it doesn't exist. "" is the virtual root. */
export function subtreeAt<T extends DrillNode>(roots: T[], path: string): T | null {
  if (!path) return null;
  let level: readonly T[] = roots;
  let found: T | null = null;
  for (const seg of path.split("/")) {
    const acc: string = found ? `${found.path}/${seg}` : seg;
    found = (level.find((n) => n.path === acc) as T | undefined) ?? null;
    if (!found) return null;
    level = found.children as T[];
  }
  return found;
}

/**
 * After a refresh the drilled-into folder may be gone; fall back to the
 * deepest ancestor that still exists ("" when even the top segment vanished).
 */
export function deepestExistingPath<T extends DrillNode>(roots: T[], path: string): string {
  if (!path) return "";
  let level: DrillNode[] = roots;
  let good = "";
  let acc = "";
  for (const seg of path.split("/")) {
    acc = acc ? `${acc}/${seg}` : seg;
    const next = level.find((n) => n.path === acc);
    if (!next) break;
    good = acc;
    level = next.children;
  }
  return good;
}
