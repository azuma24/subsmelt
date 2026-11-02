/** Breadcrumb model for drill-down navigation. Pure — no React. */

export interface BreadcrumbItem {
  label: string;
  path: string;
}

/** Marker emitted by truncateBreadcrumb where middle segments were dropped. */
export const ELLIPSIS = "ellipsis" as const;
export type BreadcrumbEntry = BreadcrumbItem | typeof ELLIPSIS;

/** "a/b/c" → [home, a, a/b, a/b/c]; "" → [home]. */
export function breadcrumbItems(path: string, homeLabel: string): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [{ label: homeLabel, path: "" }];
  if (!path) return items;
  let acc = "";
  for (const seg of path.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg;
    items.push({ label: seg, path: acc });
  }
  return items;
}

/**
 * Cap the trail at maxItems entries by replacing middle segments with one
 * ellipsis. Home and the deepest segments always survive — those are the only
 * jump targets that stay unambiguous when context is dropped.
 */
export function truncateBreadcrumb(items: BreadcrumbItem[], maxItems: number): BreadcrumbEntry[] {
  if (items.length <= maxItems) return items;
  const tailCount = Math.max(1, maxItems - 2);
  return [items[0], ELLIPSIS, ...items.slice(items.length - tailCount)];
}
