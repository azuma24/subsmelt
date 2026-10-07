export type SortDir = "asc" | "desc";
export type SortValue = number | string | null;

export interface TableSort {
  key: string;
  dir: SortDir;
}

/** A sorted copy of `rows`; rows without a value go last in either direction. */
export function sortRows<Row>(rows: readonly Row[], value: (row: Row) => SortValue, dir: SortDir): Row[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
    const order = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return order * sign;
  });
}

/** Clicking the active column flips it; another column starts at its natural direction. */
export function nextSort(current: TableSort, key: string, firstDir: SortDir): TableSort {
  if (current.key !== key) return { key, dir: firstDir };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}
