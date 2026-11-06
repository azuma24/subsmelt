export const SUBTITLE_INTAKE_FALLBACKS = ["off", "transcribe", "transcribe_and_translate"] as const;
export type SubtitleIntakeFallback = (typeof SUBTITLE_INTAKE_FALLBACKS)[number];
export type SubtitleIntakeAction =
  | Exclude<SubtitleIntakeFallback, "off">
  | "sidecar"
  | "embedded"
  | "imported"
  | "absent"
  | "settling"
  | "ambiguous"
  | "forced_only"
  | "language_mismatch"
  | "invalid_sidecar"
  | "bitmap"
  | "unsupported"
  | "probe_failed"
  | "import_failed"
  | "asr_unavailable"
  | "no_speech";

export interface SubtitleIntakeRule {
  path: string;
  language: string;
  fallback: SubtitleIntakeFallback;
}

export interface SubtitleIntakeDecision {
  action: SubtitleIntakeAction;
  language: string;
  file?: string;
  track?: number;
  revision?: string;
}

export const SUBTITLE_LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i;

export function isSubtitleIntakeRule(value: unknown): value is SubtitleIntakeRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as SubtitleIntakeRule;
  return (
    typeof rule.path === "string" &&
    !rule.path.startsWith("/") &&
    !rule.path.includes("\\") &&
    !rule.path.includes("\0") &&
    (rule.path === "" || rule.path.split("/").every((part) => part !== "" && part !== "." && part !== "..")) &&
    typeof rule.language === "string" &&
    !/^(auto|und)$/i.test(rule.language) &&
    SUBTITLE_LANGUAGE_TAG.test(rule.language) &&
    SUBTITLE_INTAKE_FALLBACKS.includes(rule.fallback)
  );
}

export function parseSubtitleIntakeRules(raw: string): SubtitleIntakeRule[] {
  try {
    const rules: unknown = JSON.parse(raw);
    return Array.isArray(rules) ? rules.filter(isSubtitleIntakeRule) : [];
  } catch {
    return [];
  }
}

export function subtitleIntakeRulesError(raw: string): string | null {
  const rules: unknown = JSON.parse(raw);
  if (!Array.isArray(rules) || !rules.every(isSubtitleIntakeRule)) {
    return "Subtitle intake rules need a media-relative folder, a source language code, and a fallback action.";
  }
  if (new Set(rules.map((rule) => rule.path)).size !== rules.length) {
    return "Only one subtitle intake rule can be assigned to each folder.";
  }
  return null;
}
