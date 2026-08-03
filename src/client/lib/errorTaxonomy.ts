/**
 * Turn raw failure strings into a cause the user can act on.
 *
 * Errors reach the UI exactly as the backend, the OS, or the LLM SDK produced
 * them — `fetch failed`, `terminated`, `[WinError 2] The system cannot find the
 * file specified`. Each is accurate and none tells the user what to do. This maps
 * them to a small set of causes, each with a one-line explanation and next step.
 *
 * The raw text is never discarded; callers show it alongside, because it is what
 * makes a bug report useful.
 */

export type ErrorCode =
  | "backend-unreachable"
  | "connection-dropped"
  | "timeout"
  | "auth"
  | "rate-limit"
  | "model-missing"
  | "insufficient-ram"
  | "insufficient-disk"
  | "ffmpeg-missing"
  | "server-missing"
  | "schema"
  | "cancelled"
  | "interrupted"
  | "unknown";

interface Rule {
  code: ErrorCode;
  patterns: string[];
}

// Order matters: the first match wins, so specific causes are listed before the
// generic transport ones they would otherwise be swallowed by. "model not
// downloaded" must beat "not found"; a cuDNN "file not found" must beat the
// Windows launcher one.
const RULES: Rule[] = [
  { code: "cancelled", patterns: ["cancelled", "canceled", "aborted", "stop_requested"] },
  { code: "interrupted", patterns: ["interrupted by server restart", "server restart"] },
  { code: "model-missing", patterns: ["model_not_downloaded", "not downloaded", "model is not downloaded"] },
  { code: "insufficient-ram", patterns: ["insufficient_ram", "not enough memory", "out of memory", "oom"] },
  { code: "insufficient-disk", patterns: ["insufficient_disk", "no space left", "disk full"] },
  { code: "ffmpeg-missing", patterns: ["ffmpeg_missing", "ffmpeg not found", "ffmpeg is not"] },
  { code: "server-missing", patterns: ["winerror 2", "cannot find the file specified", "run_server executable not found", "enoent"] },
  { code: "auth", patterns: ["unauthorized", "forbidden", "invalid token", "invalid api key", "401", "403"] },
  { code: "rate-limit", patterns: ["rate limit", "rate_limit", "429", "too many requests"] },
  { code: "schema", patterns: ["did not match schema", "no object generated", "validation", "unusable response"] },
  { code: "timeout", patterns: ["timed out", "timeout", "etimedout"] },
  { code: "connection-dropped", patterns: ["terminated", "socket hang up", "econnreset", "premature close"] },
  { code: "backend-unreachable", patterns: ["fetch failed", "econnrefused", "enotfound", "eai_again", "network error", "failed to connect", "connection refused"] },
];

export function classifyError(raw: string | null | undefined): ErrorCode {
  if (!raw || !raw.trim()) return "unknown";
  const text = raw.toLowerCase();
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => text.includes(pattern))) return rule.code;
  }
  return "unknown";
}

/**
 * Where the failure came from. The same raw string means different things in
 * different places: `fetch failed` from a transcription is the Whisper service
 * being down, while from a queue job it is the configured LLM endpoint — and
 * sending the user to the wrong settings page is worse than saying nothing.
 */
export type ErrorContext = "transcription" | "translation";

/**
 * i18n keys for the explanation, most specific first, or null for "unknown" —
 * there is nothing useful to say about an error we do not recognise, so callers
 * show the raw text alone rather than a vacuous "something went wrong".
 *
 * i18next resolves the first key that exists, so only the causes whose guidance
 * actually differs need a context-specific override; the rest fall through to
 * the shared sentence.
 */
export function errorHintKeys(code: ErrorCode, context: ErrorContext = "transcription"): string[] | null {
  if (code === "unknown") return null;
  return context === "transcription"
    ? [`errors.${code}`]
    : [`errors.${context}.${code}`, `errors.${code}`];
}
