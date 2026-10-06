/**
 * Budgets for the cascade-and-fallback path, and the loop that walks a line
 * through it.
 *
 * These numbers are the fix for a job that could occupy ~10 hours instead of
 * failing: the per-line fallback used to inherit the full job timeout AND its
 * own retry budget, so one unresponsive backend turned a single 20-line chunk
 * into twenty sequential multi-minute stalls. They lived as constants inside
 * `translateFile`, where no test could reach them.
 */

/** Per-line calls are small; they must not inherit a multi-minute job timeout. */
export const SINGLE_LINE_TIMEOUT_CAP_MS = 60_000;
/** One retry per connection for a single line — the chunk pass already tried hard. */
export const SINGLE_LINE_RETRIES = 1;
/** Consecutive line failures before the whole fallback is abandoned. */
export const SINGLE_LINE_FAILURE_LIMIT = 3;

/**
 * Timeout for a single-line call: the job timeout, capped. An unset job timeout
 * still gets the cap rather than running unbounded.
 */
export function singleLineTimeoutMs(jobTimeoutMs: number | undefined): number {
  return jobTimeoutMs ? Math.min(jobTimeoutMs, SINGLE_LINE_TIMEOUT_CAP_MS) : SINGLE_LINE_TIMEOUT_CAP_MS;
}

export interface LineFallbackResult {
  /** Translations by index; a slot stays null when that line could not be done. */
  translations: (string | null)[];
  /** Lines that failed before the run was abandoned. */
  failures: number;
}

export interface LineFallbackOptions {
  /** Translate one line, or throw. */
  translateLine: (lineText: string, index: number) => Promise<string>;
  /** Consecutive failures tolerated before giving up. */
  failureLimit?: number;
  /** Called for the error that triggered the abort. */
  onAbort?: (error: unknown, consecutiveFailures: number) => void;
}

/**
 * Walk lines through the per-line fallback, abandoning the whole run once the
 * backend has clearly stopped answering.
 *
 * Throws on abort (and propagates STOP_REQUESTED immediately) so the caller
 * fails the chunk rather than grinding through every remaining line at one full
 * timeout each — which is exactly what made jobs look hung.
 */
export async function runLineFallback(
  lines: string[],
  options: LineFallbackOptions,
): Promise<LineFallbackResult> {
  const limit = options.failureLimit ?? SINGLE_LINE_FAILURE_LIMIT;
  const translations: (string | null)[] = new Array(lines.length).fill(null);
  let consecutiveFailures = 0;
  let failures = 0;

  for (let index = 0; index < lines.length; index++) {
    try {
      translations[index] = await options.translateLine(lines[index], index);
      consecutiveFailures = 0;
    } catch (error: any) {
      if (error?.message === "STOP_REQUESTED") throw error;
      consecutiveFailures += 1;
      failures += 1;
      if (consecutiveFailures >= limit) {
        options.onAbort?.(error, consecutiveFailures);
        throw new Error(
          `Per-line fallback aborted after ${consecutiveFailures} consecutive failures: ${error?.message || error}`,
        );
      }
    }
  }

  return { translations, failures };
}
