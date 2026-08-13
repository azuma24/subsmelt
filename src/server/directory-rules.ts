import path from "node:path";

/**
 * Per-directory translation control. Stored as a JSON array in the
 * `directory_rules` setting (same JSON-in-settings pattern as scan_profiles /
 * llm_connections). A rule applies to its directory and every subfolder.
 */
export type TriState = "inherit" | "on" | "off";

export interface DirectoryRule {
  id: string;
  /** Relative to MEDIA_DIR, posix, no leading/trailing slash. "" = media root (matches everything). */
  path: string;
  enabled: boolean;
  /** Whether subtitles without a companion video translate in this subtree. */
  translateWithoutVideo: TriState;
  /** Extra language-task IDs to apply in this subtree (additive — union with global enabled tasks). */
  taskIds: number[];
}

export interface ResolvedDirectoryRule {
  /** Effective decision for videoless subtitles in this directory. */
  translateWithoutVideo: boolean;
  /** Extra task IDs to add on top of the global enabled tasks. */
  extraTaskIds: number[];
  /** Most-specific matching rule id, for UI display. null when nothing matched. */
  matchedRuleId: string | null;
}

const TRI_STATES: TriState[] = ["inherit", "on", "off"];

/**
 * Normalize a rule path to a MEDIA_DIR-relative posix path with no leading or
 * trailing slash. Returns null when the path escapes the media root or is
 * otherwise unsafe. "" (the media root) is a valid result.
 */
export function normalizeRulePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/\\/g, "/");
  if (cleaned.includes("\0")) return null;
  // Strip leading slashes so absolute-looking input is treated as relative.
  const stripped = cleaned.replace(/^\/+/, "");
  const normalized = path.posix.normalize(stripped);
  if (normalized === "." || normalized === "") return "";
  if (normalized.startsWith("../") || normalized === "..") return null;
  return normalized.replace(/\/+$/, "");
}

function toTaskIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v === "number" && Number.isFinite(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Parse and validate the `directory_rules` setting. Malformed entries are dropped. */
export function parseRules(raw: string): DirectoryRule[] {
  let value: unknown;
  try {
    value = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];

  const rules: DirectoryRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id) continue;
    const normalizedPath = normalizeRulePath(e.path);
    if (normalizedPath === null) continue;
    const tri = TRI_STATES.includes(e.translateWithoutVideo as TriState)
      ? (e.translateWithoutVideo as TriState)
      : "inherit";
    rules.push({
      id: e.id,
      path: normalizedPath,
      // Missing/omitted enabled defaults to active, matching the client parser.
      enabled: e.enabled !== false,
      translateWithoutVideo: tri,
      taskIds: toTaskIds(e.taskIds),
    });
  }
  return rules;
}

function matches(relDir: string, rulePath: string): boolean {
  if (rulePath === "") return true;
  return relDir === rulePath || relDir.startsWith(`${rulePath}/`);
}

/**
 * Resolve the effective rule for a directory (MEDIA_DIR-relative posix path).
 * Longest-prefix (most specific) wins for the videoless flag; tri-state
 * `inherit` falls through to the next ancestor and finally the global default.
 * Extra task IDs are unioned across every matching rule.
 */
export function resolveDirectoryRule(
  relDir: string,
  rules: DirectoryRule[],
  globalTranslateWithoutVideo: boolean
): ResolvedDirectoryRule {
  const matching = rules
    .filter((r) => r.enabled && matches(relDir, r.path))
    // Most specific (longest path) first.
    .sort((a, b) => b.path.length - a.path.length);

  let translateWithoutVideo = globalTranslateWithoutVideo;
  for (const r of matching) {
    if (r.translateWithoutVideo !== "inherit") {
      translateWithoutVideo = r.translateWithoutVideo === "on";
      break;
    }
  }

  const extraTaskIds: number[] = [];
  for (const r of matching) {
    for (const id of r.taskIds) {
      if (!extraTaskIds.includes(id)) extraTaskIds.push(id);
    }
  }

  return {
    translateWithoutVideo,
    extraTaskIds,
    matchedRuleId: matching.length > 0 ? matching[0].id : null,
  };
}
