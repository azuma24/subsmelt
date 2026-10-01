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

/**
 * A task's output_pattern is composed into an output path inside MEDIA_DIR
 * (path.join of the media folder and the substituted pattern), so `..`, an
 * absolute prefix or a backslash would escape the media folder when the queue
 * writes the translation.
 */
export function validateOutputPattern(pattern: string): Parsed<string> {
  const value = pattern.trim() || "{{name}}.{{lang_code}}.srt";
  if (value.includes("..") || value.startsWith("/") || value.includes("\\")) {
    return { ok: false, error: "output_pattern must stay inside the media folder" };
  }
  return { ok: true, value };
}

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
    if (field === "output_pattern") {
      const pattern = validateOutputPattern(value);
      if (!pattern.ok) return { ok: false, error: pattern.error };
      update[field] = pattern.value;
      continue;
    }
    update[field] = value;
  }
  if (input.enabled !== undefined) {
    if (input.enabled !== 0 && input.enabled !== 1) return { ok: false, error: "enabled must be 0 or 1" };
    update.enabled = input.enabled;
  }
  return { ok: true, value: update };
}

export type LogsQuery = {
  level?: string;
  category?: string;
  jobId?: number;
  limit: number;
  offset: number;
};

const LOGS_QUERY_KEYS = ["level", "category", "job_id", "limit", "offset"] as const;

/** Query of GET /api/logs. Repeated keys (`level[]=a&level[]=b`) arrive as arrays. */
export function parseLogsQuery(query: Record<string, unknown>): Parsed<LogsQuery> {
  for (const key of LOGS_QUERY_KEYS) {
    const value = query[key];
    if (value !== undefined && typeof value !== "string") {
      return { ok: false, error: `${key} must be a single value` };
    }
  }
  const { level, category, job_id, limit, offset } = query as Partial<
    Record<(typeof LOGS_QUERY_KEYS)[number], string>
  >;
  const parsedJobId = job_id === undefined ? NaN : parseInt(job_id, 10);
  return {
    ok: true,
    value: {
      level,
      category,
      jobId: Number.isFinite(parsedJobId) ? parsedJobId : undefined,
      limit: parseBoundedNonNegativeInt(limit, 100, MAX_LOG_LIMIT),
      offset: parseBoundedNonNegativeInt(offset, 0, MAX_LOG_OFFSET),
    },
  };
}
