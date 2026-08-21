import type { KeyValueStorage } from "../../components/file-tree/expansion-store";

const KEY = "convert.recentTargets";
const MAX_RECENTS = 5;

export function loadRecentTargets(storage: KeyValueStorage): string[] {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string").slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function pushRecentTarget(storage: KeyValueStorage, code: string): string[] {
  const next = [code, ...loadRecentTargets(storage).filter((c) => c !== code)].slice(0, MAX_RECENTS);
  try {
    storage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — recents just won't persist.
  }
  return next;
}
