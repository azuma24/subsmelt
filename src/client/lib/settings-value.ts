/**
 * Coercion for settings values.
 *
 * Settings arrive from the API as `Record<string, unknown>` — the server stores
 * everything as strings, but nothing in the type system guarantees a given key
 * is present or is a string. These helpers make "read a setting with a default"
 * a single call instead of a ternary at every use site.
 *
 * This existed as four byte-identical copies (SettingsPage, WhisperPage,
 * DashboardPage, TranscriptionReadinessPanel).
 */

/** A settings value as a string, falling back when absent or non-string. */
export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A settings value as a number, falling back when absent or unparseable. */
export function num(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(str(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A settings flag. The server writes "1"/"0"; booleans are accepted too. */
export function flag(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "1";
  return fallback;
}
