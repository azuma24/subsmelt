export interface StagedFile {
  id: string;
  file: File;
  /** Detected source language code; undefined = not attempted yet, null = detection failed. */
  detected?: string | null;
  /** Manual per-file source override (language code); null = trust detection. */
  override: string | null;
  /** Skip translation for this file (convert format only). */
  skip: boolean;
}

/** Effective source code: per-file override, then page-level From, then detection. */
export function effectiveSource(s: StagedFile, globalFrom?: string): string | null {
  if (s.override) return s.override;
  if (globalFrom) return globalFrom;
  return s.detected ?? null;
}

/** The "skip translation" choice is only offered when the source already is the target. */
export function isSameAsTarget(s: StagedFile, globalFrom: string | undefined, translate: boolean, targetCode: string | null): boolean {
  const source = effectiveSource(s, globalFrom);
  return translate && targetCode !== null && source !== null && source === targetCode;
}

/** What the request carries: a skip ticked while the checkbox was offered, and only then. */
export function skipTranslation(s: StagedFile, globalFrom: string | undefined, translate: boolean, targetCode: string | null): boolean {
  return s.skip && isSameAsTarget(s, globalFrom, translate, targetCode);
}
