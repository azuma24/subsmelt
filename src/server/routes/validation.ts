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

/**
 * Language names end up inside the LLM system prompt: cap length and strip
 * control characters and template-ish braces so request input can't
 * restructure the prompt.
 */
export function sanitizeLanguageName(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/[{}<>]/g, "").trim().slice(0, 60);
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

/**
 * Allowed ranges for the numeric settings. Readers parse these leniently, so an
 * out-of-range value used to do damage quietly: chunk_size 0 sent a whole file
 * as one request, request_timeout_s 0 became 5 s. The Settings inputs carry the
 * same min/max (EngineSection, SourcesSection, SttAdvancedFields).
 */
export const NUMERIC_SETTING_BOUNDS: Record<string, { min: number; max: number; integer: boolean }> = {
  chunk_size: { min: 1, max: 500, integer: true },
  context_window: { min: 0, max: 100, integer: true },
  parallel_chunks: { min: 1, max: 8, integer: true },
  request_timeout_s: { min: 10, max: 7200, integer: true },
  temperature: { min: 0, max: 2, integer: false },
  auto_scan_interval: { min: 0, max: 10080, integer: true },
  monthly_token_budget: { min: 0, max: 1_000_000_000_000, integer: true },
  transcription_max_concurrent: { min: 1, max: 4, integer: true },
  transcription_request_timeout_s: { min: 30, max: 86400, integer: true },
  // 0 turns the limit off.
  transcription_max_line_length: { min: 0, max: 200, integer: true },
  transcription_max_subtitle_duration: { min: 0, max: 60, integer: false },
};

const INTEGER_SYNTAX = /^-?\d+$/;
const DECIMAL_SYNTAX = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** null when `value` is fine for `key` (or `key` is not numeric), else why not. */
export function numericSettingError(key: string, value: string): string | null {
  const bounds = NUMERIC_SETTING_BOUNDS[key];
  if (!bounds) return null;
  // Plain decimal only: readers use parseInt/parseFloat, which would read
  // "1e2" as 1 and "0x10" as 0, so anything Number() accepts but they do not
  // would pass here and mean something else at runtime.
  const syntax = bounds.integer ? INTEGER_SYNTAX : DECIMAL_SYNTAX;
  const parsed = syntax.test(value) ? Number(value) : NaN;
  const fits = Number.isFinite(parsed)
    && parsed >= bounds.min
    && parsed <= bounds.max;
  if (fits) return null;
  return `${key} must be ${bounds.integer ? "a whole number" : "a number"} from ${bounds.min} to ${bounds.max}`;
}
