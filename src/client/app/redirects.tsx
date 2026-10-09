import { Navigate, useLocation } from "react-router-dom";

/** Routes that moved; bookmarks and old in-app links land on the new home. */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  "/translations": "/settings/languages",
  "/tasks": "/settings/languages",
  "/logs": "/settings/logs",
  "/activity": "/?view=jobs",
};

/**
 * Where a legacy URL goes, query string kept (so /logs?job=12 still filters to
 * job 12). A target with its own query merges with the incoming one; the
 * incoming value wins on a clash.
 */
export function legacyRedirect(pathname: string, search: string): string | null {
  const target = LEGACY_REDIRECTS[pathname];
  if (!target) return null;
  const [path, targetQuery = ""] = target.split("?");
  const merged = new URLSearchParams(targetQuery);
  for (const [key, value] of new URLSearchParams(search)) merged.set(key, value);
  const query = merged.toString();
  return query ? `${path}?${query}` : path;
}

export function LegacyRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={legacyRedirect(pathname, search) ?? "/"} replace />;
}
