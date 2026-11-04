import type { JobConnection } from "../../shared/jobs.js";
import { broadcast } from "../sse.js";

/**
 * The in-memory state of the live queue run: which jobs translate right now,
 * how to abort them, which connection each runs on and which connections the
 * run has given up on. The pump (queue.ts) and the per-job stages (run-job.ts)
 * share it; routes read it through the accessors.
 */

export type { JobConnection };

let stopRequested = false;
let currentJobId: number | null = null;
// Jobs translating right now (one per active worker in parallel mode).
const activeJobIds = new Set<number>();
// One AbortController per in-flight job; a queue stop aborts them all.
const abortControllers = new Map<number, AbortController>();
// Jobs the user cancelled while translating: their abort surfaces through the
// same fetch errors a stop does, so the job stages need this set to tell the
// two apart — a cancelled job ends as error, a stopped one back to pending.
const cancelledJobIds = new Set<number>();
// The LLM connection each translating job runs on, so the dashboard can show
// which machine is working on what in parallel mode.
const jobConnections = new Map<number, JobConnection>();
// When each job's analysis pass started, while it runs.
const analyzingSince = new Map<number, number>();
// Every connection a split job is using; a split job has no single connection.
const splitJobConnections = new Map<number, JobConnection[]>();
// Connections this run found unreachable and stopped using.
const offlineConnectionIds = new Set<string>();

export function isStopRequested(): boolean {
  return stopRequested;
}

export function setStopRequested(value: boolean): void {
  stopRequested = value;
}

export function getCurrentJobId(): number | null {
  return currentJobId;
}

export function getActiveJobIds(): number[] {
  return Array.from(activeJobIds);
}

export function activeJobCount(): number {
  return activeJobIds.size;
}

/** Marks a claimed job as translating; the newest claim is the "current" job. */
export function registerActiveJob(jobId: number): void {
  activeJobIds.add(jobId);
  currentJobId = jobId;
}

/** Registers the controller a job's LLM calls abort through. */
export function registerAbort(jobId: number, controller: AbortController): void {
  abortControllers.set(jobId, controller);
}

/**
 * Clears a finished job's registrations, but only for the run that still owns
 * them: a cancel during the title sidecar can settle one run after a re-run has
 * already claimed the job, and clearing then would strip the new run's
 * controller and activity marker. The cancel marker is per job, not per run:
 * clearing it always is what keeps a stale cancel from killing a re-run.
 */
export function releaseJob(jobId: number, controller: AbortController): void {
  if (abortControllers.get(jobId) === controller) {
    abortControllers.delete(jobId);
    jobConnections.delete(jobId);
    analyzingSince.delete(jobId);
    splitJobConnections.delete(jobId);
    activeJobIds.delete(jobId);
    currentJobId = activeJobIds.size > 0 ? Array.from(activeJobIds)[activeJobIds.size - 1] : null;
  }
  cancelledJobIds.delete(jobId);
}

/** Aborts every in-flight job's LLM calls (a queue stop). */
export function abortAllJobs(reason: string): void {
  for (const controller of abortControllers.values()) controller.abort(reason);
}

/** Marks one job cancelled and aborts its LLM calls; false when it is not translating. */
export function cancelJob(jobId: number): boolean {
  const controller = abortControllers.get(jobId);
  if (!controller) return false;
  cancelledJobIds.add(jobId);
  controller.abort(new Error("JOB_CANCELLED"));
  return true;
}

export function isJobCancelled(jobId: number): boolean {
  return cancelledJobIds.has(jobId);
}

export function clearJobCancel(jobId: number): void {
  cancelledJobIds.delete(jobId);
}

export function setJobAnalyzing(jobId: number, running: boolean): void {
  const since = running ? Date.now() : null;
  if (since === null) analyzingSince.delete(jobId);
  else analyzingSince.set(jobId, since);
  broadcast("job:analyzing", { jobId, since });
}

/** When a translating job's analysis pass started, or null when it is not in one. */
export function getJobAnalyzingSince(jobId: number): number | null {
  return analyzingSince.get(jobId) ?? null;
}

export function setJobConnection(jobId: number, connection: JobConnection): void {
  jobConnections.set(jobId, connection);
  broadcast("job:connection", { jobId, ...connection });
}

export function setSplitJobConnections(jobId: number, connections: JobConnection[]): void {
  splitJobConnections.set(jobId, connections);
}

/** A split job stops using a connection it lost; it keeps reporting its last one. */
export function dropSplitJobConnection(jobId: number, id: string): void {
  const remaining = (splitJobConnections.get(jobId) ?? []).filter((conn) => conn.id !== id);
  if (remaining.length === 0) return;
  splitJobConnections.set(jobId, remaining);
  if (jobConnections.get(jobId)?.id === id) setJobConnection(jobId, remaining[0]);
}

/** The connection a translating job currently runs on, or null. */
export function getJobConnection(jobId: number): JobConnection | null {
  return jobConnections.get(jobId) ?? null;
}

/** Every translating job with its connections, for the queue status surface. A split job appears once per connection. */
export function getActiveJobConnections(): ({ jobId: number } & JobConnection)[] {
  return Array.from(jobConnections).flatMap(([jobId, connection]) =>
    (splitJobConnections.get(jobId) ?? [connection]).map((conn) => ({ jobId, ...conn })),
  );
}

export function markConnectionOffline(id: string): void {
  offlineConnectionIds.add(id);
}

export function isConnectionOffline(id: string): boolean {
  return offlineConnectionIds.has(id);
}

/** Connections this queue run found unreachable and stopped using. */
export function getOfflineConnectionIds(): string[] {
  return Array.from(offlineConnectionIds);
}

/** Forgets every job and connection of the run that just ended. */
export function resetRunState(): void {
  stopRequested = false;
  currentJobId = null;
  activeJobIds.clear();
  abortControllers.clear();
  cancelledJobIds.clear();
  jobConnections.clear();
  analyzingSince.clear();
  splitJobConnections.clear();
  offlineConnectionIds.clear();
}
