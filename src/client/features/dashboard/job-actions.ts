// Shared, framework-agnostic helpers for dashboard job actions.
//
// The React hook that wires these into mutations + toasts lives in
// `src/client/hooks/useJobActions.ts`. Keeping the pure classifier here means
// both the desktop table and the mobile card import the exact same logic
// instead of duplicating it (frontend-audit §9).

// Maps a raw job error string onto a stable reason slug used to look up a
// localized label (`dashboard.errorReason.<reason>`). Returns "unknown" when no
// error is present so callers can branch on a single value.
export function classifyErrorReason(error: string | null): string {
  if (!error) return "unknown";
  const text = error.toLowerCase();
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  if (text.includes("connection") || text.includes("econnrefused") || text.includes("network")) return "endpoint";
  if (text.includes("rate limit") || text.includes("429")) return "rate-limit";
  if (text.includes("schema") || text.includes("validation")) return "schema";
  if (text.includes("not found") || text.includes("404")) return "not-found";
  return "other";
}
