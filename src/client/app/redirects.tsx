import { Navigate, useLocation } from "react-router-dom";

/** Routes that moved; bookmarks and old in-app links land on the new home. */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  "/translations": "/settings/languages",
  "/tasks": "/settings/languages",
  "/logs": "/settings/logs",
};

/** Where a legacy URL goes, query string kept (so /logs?job=12 still filters to job 12). */
export function legacyRedirect(pathname: string, search: string): string | null {
  const target = LEGACY_REDIRECTS[pathname];
  return target ? `${target}${search}` : null;
}

export function LegacyRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={legacyRedirect(pathname, search) ?? "/"} replace />;
}
