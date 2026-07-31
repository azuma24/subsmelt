export const MAX_LOG_LIMIT = 500;
export const MAX_LOG_OFFSET = 1_000_000;

export function parseBoundedNonNegativeInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parsePositiveIntegerArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parsePositiveInteger);
  if (parsed.some((item) => item === null)) return null;
  return Array.from(new Set(parsed as number[]));
}
