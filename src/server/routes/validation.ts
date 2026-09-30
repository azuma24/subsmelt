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

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type TaskUpdate = Partial<{
  source_lang: string;
  target_lang: string;
  output_pattern: string;
  lang_code: string;
  enabled: 0 | 1;
  prompt_override: string;
}>;

const TASK_TEXT_FIELDS = ["source_lang", "target_lang", "output_pattern", "lang_code", "prompt_override"] as const;
// Same requirement POST /api/tasks enforces on create.
const REQUIRED_TASK_FIELDS: ReadonlySet<string> = new Set(["target_lang", "lang_code"]);

/**
 * Body of PUT /api/tasks/:id. Clients send the whole task back, so keys outside
 * the editable set (id, created_at) are dropped; an editable key of the wrong
 * type is an error.
 */
export function parseTaskUpdate(body: unknown): Parsed<TaskUpdate> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const update: TaskUpdate = {};
  for (const field of TASK_TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
    if (!value && REQUIRED_TASK_FIELDS.has(field)) return { ok: false, error: `${field} must not be empty` };
    update[field] = value;
  }
  if (input.enabled !== undefined) {
    if (input.enabled !== 0 && input.enabled !== 1) return { ok: false, error: "enabled must be 0 or 1" };
    update.enabled = input.enabled;
  }
  return { ok: true, value: update };
}
