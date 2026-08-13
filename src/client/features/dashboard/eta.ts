/**
 * Time-remaining estimates for translation work.
 *
 * Batch translations run for tens of minutes to hours, so "42% · 310/740 cues"
 * on its own doesn't answer the question users actually have: can I walk away?
 * These helpers turn observed throughput into a projection.
 *
 * Deliberately linear: cue translation rate is roughly constant within a job
 * (same model, same chunk size), and a fancier model would be false precision on
 * top of an LLM whose latency swings anyway. Estimates are labelled approximate.
 */

/** Ignore throughput measured over less than this — early samples are noise. */
export const MIN_ELAPSED_MS = 10_000;
/** Ignore throughput until at least this many cues are done. */
export const MIN_COMPLETED_CUES = 3;

export interface JobEta {
  /** Observed translation rate, cues per minute. */
  cuesPerMinute: number;
  /** Projected time left in milliseconds. */
  remainingMs: number;
}

export interface JobEtaInput {
  completed: number;
  total: number;
  elapsedMs: number;
}

/**
 * Project the time left on one job, or null when there isn't enough signal yet
 * (job just started, still analysing context, or already finished).
 */
export function estimateJobEta({ completed, total, elapsedMs }: JobEtaInput): JobEta | null {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || !Number.isFinite(elapsedMs)) return null;
  if (total <= 0 || completed <= 0 || completed >= total) return null;
  if (elapsedMs < MIN_ELAPSED_MS || completed < MIN_COMPLETED_CUES) return null;

  const cuesPerMs = completed / elapsedMs;
  if (cuesPerMs <= 0) return null;

  return {
    cuesPerMinute: cuesPerMs * 60_000,
    remainingMs: (total - completed) / cuesPerMs,
  };
}

/**
 * Rough projection for jobs still queued, from how long recent jobs actually
 * took. Uses the median so one pathological job (a backend timing out for an
 * hour) doesn't distort the whole queue estimate.
 */
export function estimateQueueEta(pendingCount: number, recentDurationsSeconds: number[]): number | null {
  if (pendingCount <= 0) return null;
  const usable = recentDurationsSeconds
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
    .sort((a, b) => a - b);
  if (usable.length === 0) return null;

  const middle = Math.floor(usable.length / 2);
  const medianSeconds = usable.length % 2 === 0
    ? (usable[middle - 1] + usable[middle]) / 2
    : usable[middle];

  return medianSeconds * 1000 * pendingCount;
}

/**
 * Compact duration for display: "45s", "12m", "2h 05m". Coarse on purpose —
 * second-level precision on an hour-long estimate reads as certainty it doesn't have.
 */
export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** Milliseconds a job has been running, or null when it never started. */
export function elapsedSince(startedAt: string | null | undefined, now = Date.now()): number | null {
  if (!startedAt) return null;
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone
  // marker; Date.parse would read it as local time and skew every estimate by
  // the machine's offset.
  const normalized = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(startedAt)
    ? `${startedAt.replace(" ", "T")}Z`
    : startedAt;
  const started = Date.parse(normalized);
  if (!Number.isFinite(started)) return null;
  const elapsed = now - started;
  return elapsed >= 0 ? elapsed : null;
}
