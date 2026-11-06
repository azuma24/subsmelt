import fs from "node:fs";
import path from "node:path";
import {
  countPendingJobs,
  claimJobOutput,
  claimPendingJob,
  forceJob,
  getJob,
  getJobOutputOwner,
  getJobsForList,
  updateJob,
  type JobRow,
} from "./db.js";
import { getAllSettings, getTask, getSetting } from "./config.js";
import { readSettings } from "./settings-schema.js";
import { resolveConnectionPool, type ResolvedConnection, type LlmMode } from "./connections.js";
import { logger } from "./logger.js";
import { broadcast } from "./sse.js";
import { notify } from "./notify.js";
import { acquireConnectionLock, resetConnectionLocks } from "./connection-lock.js";
import { existingTaskOutput, standardOutputFor } from "./output-names.js";
import { caseKey } from "./media-paths.js";
import {
  clearHeldQueueStart,
  currentTranslationGate,
  holdQueueStart,
  setTranslationQueueSource,
  takeHeldStart,
} from "./gpu-gate.js";
import { errorMessage } from "./errors.js";
import {
  abortAllJobs,
  activeJobCount,
  cancelJob,
  isConnectionOffline,
  isStopRequested,
  registerActiveJob,
  resetRunState,
  setStopRequested,
} from "./queue/state.js";
import { runJob } from "./queue/run-job.js";
import { writeJobTitle } from "./queue/titles.js";
import { clearQueueRun, interruptedQueueRun, markQueueRun, writeQueueRun } from "./queue/run-marker.js";
import { recordUsage } from "./usage.js";
import { removeJobPartialOutput } from "./job-output.js";
import { hasAutomaticTranslationRestrictions, isAutomaticTranslationAllowed } from "./transcription/review-gate.js";

// The per-job state (what translates now, on which connection, what was
// cancelled) lives in ./queue/state.ts; the routes read it through these.
export {
  type JobConnection,
  getActiveJobConnections,
  getActiveJobIds,
  getCurrentJobId,
  getJobAnalyzingSince,
  getJobConnection,
  getOfflineConnectionIds,
} from "./queue/state.js";

let isRunning = false;
// The jobs the live run processes: a Run of selected jobs, or null for all.
let runFilter: Set<number> | null = null;
// A start asked for while a run of selected jobs is live: all pending jobs
// (ids undefined) or more selected ones. The live run takes it up when its
// own jobs are done, so the jobs a retry, a watcher scan or a one-off
// translation queued meanwhile are never left pending.
let requestedRun: { ids: number[] | undefined } | null = null;
// Scope explicitly requested during this run; null means all jobs.
let currentRunScope: Set<number> | null = null;
// An interrupted run can predate a newly requested start that the GPU gate holds.
let heldPriorPending: number[] | null = null;

function rememberRunRequest(ids: number[] | undefined): void {
  if (!requestedRun) requestedRun = { ids };
  else if (!requestedRun.ids || !ids) requestedRun = { ids: undefined };
  else requestedRun = { ids: [...new Set([...requestedRun.ids, ...ids])] };
}

// A split job uses every connection, so no other file starts beside it, whichever
// way the llm_split_file setting has changed since it started.
let splitJobRunning = false;

// The worker slots still in their loop. When the slot allowed to claim has left,
// the next one by rank takes over any job queued since, instead of idling beside
// it for the rest of the run.
const liveSlots = new Set<number>();
// Track claims even when setup fails before runJob can register its controller.
const claimedJobs = new Set<number>();

// Hard ceiling on concurrent translation workers (matches the per-file connection cap).
const MAX_WORKERS = 32;

// Jobs skipped because their subtitle output already exists still deserve a
// title-sidecar entry (repair for titles missed before the setting was on or
// after a failed title call). Collected during claim, processed after the run.
const titleRepairJobs: JobRow[] = [];

function availablePool(pool: ResolvedConnection[]): ResolvedConnection[] {
  const available = pool.filter((conn) => !isConnectionOffline(conn.id));
  return available.length > 0 ? available : pool;
}

/** Force re-translate: the next run starts over, while its later runs may still resume it. */
export function forceJobFromScratch(id: number): number {
  const output = getJob(id)?.output_path;
  const changed = forceJob(id);
  if (changed > 0 && output) removeJobPartialOutput(output, id);
  return changed;
}

export function isQueueRunning() {
  return isRunning;
}
setTranslationQueueSource(isQueueRunning);

export function requestStop() {
  const held = clearHeldQueueStart();
  if (isRunning) {
    setStopRequested(true);
    // Abort every in-flight LLM request immediately — don't wait for onProgress
    abortAllJobs("stop_requested");
    logger.info("queue", "Stop requested — aborting in-flight LLM calls");
  } else if (held) {
    const priorPending = heldPriorPending ?? [];
    heldPriorPending = null;
    restoreStoppedRun(priorPending, held.ids ? new Set(held.ids) : null);
    logger.info("queue", "Queue start cancelled while waiting for the shared GPU");
    broadcast("queue:stopped", {});
    void notify("queue:stopped", {});
  }
}

function restoreStoppedRun(priorPending: number[], stoppedScope: Set<number> | null): void {
  const remaining = priorPending.filter((id) => stoppedScope?.has(id) === false && getJob(id)?.status === "pending");
  if (remaining.length) writeQueueRun(remaining, true);
  else clearQueueRun();
}

function interruptedPendingIds(prior: ReturnType<typeof interruptedQueueRun>): number[] {
  // Snapshot an older all-jobs marker into concrete pending IDs: restoring an
  // unrestricted marker would also resume work that this run explicitly stopped.
  if (!prior) return [];
  const ids = prior.ids && new Set(prior.ids);
  return getJobsForList()
    .filter((job) => job.status === "pending" && (!ids || ids.has(job.id)))
    .map((job) => job.id);
}

/**
 * Cancels one translating job: aborts its LLM calls, ends the job as a
 * cancelled error, and leaves the queue running — the worker that freed up
 * claims the next pending job. Unlike a stop, the job does not come back.
 */
export function requestJobCancel(jobId: number): boolean {
  if (!cancelJob(jobId)) return false;
  logger.info("queue", `Cancel requested for job #${jobId}`, jobId);
  return true;
}

/**
 * Picks up, in a fresh process, the jobs startup reset from translating back
 * to pending. With auto-translate on that is every pending job; otherwise only
 * the run the previous process died during, so jobs nobody started stay put.
 */
export function resumeQueueOnBoot() {
  const autoTranslate = getSetting("auto_translate") === "1";
  const interrupted = interruptedQueueRun();
  if (!autoTranslate && !interrupted) return;
  const ids = autoTranslate ? undefined : (interrupted?.ids ?? undefined);
  const pending = countPendingJobs(ids ? new Set(ids) : null);
  if (pending === 0) {
    clearQueueRun();
    return;
  }
  logger.info("queue", `Resuming ${pending} pending job(s) found at startup`);
  runQueueSafely(ids);
}

/**
 * Fire-and-forget queue start for call sites that do not await the run
 * (routes, watcher, boot resume). processQueue can reject — a claim or a
 * connection-resolution error propagates out of its Promise.all — and a bare
 * call would surface as an unhandled rejection that kills the process.
 */
export function runQueueSafely(onlyIds?: number[]): void {
  processQueue(onlyIds).catch((error) => {
    logger.error("queue", `Queue run failed: ${errorMessage(error) || error}`);
  });
}

export async function processQueue(onlyIds?: number[]) {
  onlyIds = onlyIds?.length ? onlyIds : undefined;
  const prior = !isRunning ? interruptedQueueRun() : null;
  markQueueRun(onlyIds);
  if (isRunning) {
    if (!onlyIds?.length) currentRunScope = null;
    else if (currentRunScope) for (const id of onlyIds) currentRunScope.add(id);
    // A run of all jobs already re-checks for pending work before it ends.
    if (runFilter) rememberRunRequest(onlyIds);
    return;
  }
  const gate = currentTranslationGate();
  if (!gate.open) {
    const firstHold = heldPriorPending === null;
    heldPriorPending ??= interruptedPendingIds(prior);
    holdQueueStart(onlyIds);
    if (firstHold) broadcast("queue:waiting", {});
    logger.info(
      "queue",
      `Translation waits for ${gate.waitingFor} transcription(s) to finish: Whisper and the translation model share one GPU`,
    );
    return;
  }
  const held = clearHeldQueueStart();
  if (held) onlyIds = held.ids && onlyIds ? [...new Set([...held.ids, ...onlyIds])] : undefined;
  const priorPending = heldPriorPending ?? interruptedPendingIds(prior);
  heldPriorPending = null;
  isRunning = true;
  currentRunScope = onlyIds?.length ? new Set(onlyIds) : null;
  resetRunState();
  resetConnectionLocks();

  let filter = onlyIds && onlyIds.length > 0 ? new Set(onlyIds) : null;
  runFilter = filter;
  let failed = false;
  try {
    const pendingCount = countPendingJobs(filter);
    logger.info("queue", `Queue started (${pendingCount} pending jobs${filter ? ", selected subset" : ""})`);
    // Adaptive worker pool: every worker re-resolves the LLM mode on each job
    // claim, so switching Single/Fallback ⇄ Parallel takes effect mid-run without
    // restarting the queue. One slot per configured connection (capped); a slot
    // only processes when the current mode permits its index (see adaptiveWorker).
    const { all } = resolveConnectionPool(getAllSettings());
    const slots = Math.max(1, Math.min(MAX_WORKERS, all.length || 1));
    logger.info("queue", `Worker pool: up to ${slots} slot${slots === 1 ? "" : "s"} (adaptive to LLM mode)`, null, {
      stage: "worker_pool",
    });
    // processQueue() is a no-op while this run is live, so a job queued while
    // the title repair is calling the LLM has nothing to start it. Repair, then
    // look for pending work again before declaring the run finished.
    do {
      const results = await Promise.allSettled(
        Array.from({ length: slots }, (_, i) =>
          runSlot(i, filter).catch((error) => {
            // Stop siblings immediately, but retain ownership until all have settled.
            setStopRequested(true);
            abortAllJobs("queue_failure");
            throw error;
          }),
        ),
      );
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      if (isStopRequested()) break;
      await repairMissingTitles();
      filter = nextRunFilter(filter);
    } while (!isStopRequested() && hasPendingJobs(filter));

    if (isStopRequested()) {
      logger.info("queue", "Queue stopped by user request");
      broadcast("queue:stopped", {});
      void notify("queue:stopped", {});
    } else {
      logger.info("queue", "Queue finished — no more pending jobs");
      broadcast("queue:finished", {});
      void notify("queue:finished", {});
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Jobs that failed between claim and runJob (or while waiting for a lock)
    // have no job-level settlement. Do not disturb jobs already settled.
    try {
      for (const id of claimedJobs) {
        if (getJob(id)?.status === "translating") updateJob(id, { status: "pending", completed_cues: 0, error: null });
      }
      const marker = interruptedQueueRun();
      if (!failed && isStopRequested()) {
        restoreStoppedRun(priorPending, currentRunScope);
      } else if (!failed && (!marker || countPendingJobs(marker.ids ? new Set(marker.ids) : null) === 0)) {
        clearQueueRun();
      }
    } finally {
      claimedJobs.clear();
      titleRepairJobs.length = 0;
      isRunning = false;
      runFilter = null;
      requestedRun = null;
      currentRunScope = null;
      resetRunState();
      resetConnectionLocks();
      // Only announce failure once all workers and queue state have settled.
      // Do not expose exception text, which can contain paths or credentials.
      if (failed) broadcast("queue:failed", {});
    }
  }
}

/** The live run's selection, widened to a start asked for meanwhile once its own jobs are done. */
function nextRunFilter(filter: Set<number> | null): Set<number> | null {
  if (!requestedRun || hasPendingJobs(filter)) return filter;
  const next = requestedRun.ids ? new Set(requestedRun.ids) : null;
  requestedRun = null;
  runFilter = next;
  logger.info("queue", `Queue continues with ${next ? "the jobs selected meanwhile" : "all pending jobs"}`);
  return next;
}

/** Starts a run the GPU gate held back, once the gate has opened. */
export function startHeldQueue(): void {
  if (isRunning) return;
  const start = takeHeldStart();
  if (start) runQueueSafely(start.ids);
}

/**
 * Where a job's result lives. A job queued before the language-code standard
 * writes the standard name ("Show.eng.srt", not "Show.en.srt"), unless the
 * task's output is already on disk in another spelling: then the job points
 * at that file. A skipped job's preview and download open it, and a forced
 * re-translation replaces it in place instead of leaving a second file of the
 * same language beside the new one.
 */
function resolvedOutputPath(job: JobRow): string {
  const task = getTask(job.task_id);
  if (!task) return job.output_path;
  const standard = standardOutputFor(job.srt_path, job.output_path, task);
  if (fs.existsSync(standard)) return standard;
  const existing = existingTaskOutput(job.srt_path, task);
  if (!existing) return standard;
  const owner = getJobOutputOwner(existing);
  return owner && owner.id !== job.id && caseKey(existing) !== caseKey(standard) ? standard : existing;
}

/**
 * Atomically claim the next pending job. Synchronous on purpose: better-sqlite3
 * calls don't yield, so concurrent pool workers can never read-then-mark the
 * same job. Returns null when the queue is drained (or stop was requested).
 * Skipped (output-exists) jobs are consumed here and the next one is tried.
 */
function claimNextJob(filter: Set<number> | null): JobRow | null {
  while (!isStopRequested()) {
    const claimed = claimPendingJob(filter);
    if (!claimed) return null;
    claimedJobs.add(claimed.id);
    const outputPath = resolvedOutputPath(claimed);
    const job = { ...claimed, output_path: outputPath };
    const owner = getJobOutputOwner(outputPath);
    const exists = fs.existsSync(outputPath) && !job.force;
    const outputChanged = outputPath !== claimed.output_path;
    const needsClaim = !exists || (outputChanged && getJobOutputOwner(claimed.output_path)?.id === job.id);
    if ((owner && owner.id !== job.id) || (needsClaim && !claimJobOutput(job.id, outputPath))) {
      const error = `Output already belongs to another job: ${path.basename(outputPath)}`;
      logger.warn("queue", error, job.id);
      updateJob(job.id, { status: "error", error });
      continue;
    }
    if (outputChanged) {
      if (!needsClaim) updateJob(job.id, { output_path: outputPath });
      removeJobPartialOutput(claimed.output_path);
    }

    if (exists) {
      logger.info("queue", `Skipping job ${job.id}: output already exists (${job.output_path})`, job.id);
      updateJob(job.id, { status: "skipped" });
      removeJobPartialOutput(job.output_path, job.id);
      titleRepairJobs.push(job);
      continue;
    }

    registerActiveJob(job.id);
    return job;
  }
  return null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Backfill title-sidecar entries for jobs whose subtitle output already
 * existed (skipped at claim time). Cached titles make this a cheap no-op per
 * folder+language; only genuinely missing titles hit the LLM. Non-fatal.
 */
async function repairMissingTitles() {
  const jobs = titleRepairJobs.splice(0);
  const typed = readSettings();
  if (!typed.title_sidecar || jobs.length === 0) return;

  const settings = getAllSettings();
  const { pool } = resolveConnectionPool(settings);
  const primary = availablePool(pool)[0];
  if (!primary) return;
  const requestTimeoutMs = Math.max(5_000, typed.request_timeout_s * 1000);

  for (const job of jobs) {
    if (isStopRequested()) return;
    const task = getTask(job.task_id);
    await writeJobTitle(job, "Title repair", {
      langCode: task?.lang_code || "?",
      targetLang: task?.target_lang || "",
      connection: primary,
      temperature: typed.temperature,
      disableToolCalls: typed.disable_tool_calls,
      requestTimeoutMs,
      onUsage: (u) => recordUsage({ ...u, jobId: job.id, src: job.srt_path, srtName: path.basename(job.srt_path) }),
    });
  }
}

function hasPendingJobs(filter: Set<number> | null): boolean {
  return countPendingJobs(filter) > 0;
}

/**
 * Adaptive worker. Each loop re-resolves the current LLM mode + pool so a mode
 * change applies mid-run:
 *  - parallel (pool > 1): each worker pins its own connection and claims
 *    the next file (work-stealing); the other connections act as per-file fallbacks.
 *  - split (llm_split_file on, parallel): only the lowest live worker claims, once no other file is
 *    running, so files run one at a time and each one's chunks go to every connection.
 *  - single / fallback: only the lowest live worker runs (one file at a time); the
 *    rest idle. If the mode later widens to parallel, idle workers pick up jobs.
 * A worker exits when the queue is drained (or stop is requested).
 */
async function runSlot(index: number, filter: Set<number> | null) {
  liveSlots.add(index);
  try {
    await adaptiveWorker(index, filter);
  } finally {
    liveSlots.delete(index);
  }
}

async function adaptiveWorker(index: number, filter: Set<number> | null) {
  // Idle slots used to run a COUNT query every 500ms each; with several
  // connections configured that is a constant stream of pointless queries for
  // the whole run. Back off while idle, and reset as soon as this slot works.
  const IDLE_MIN_MS = 500;
  const IDLE_MAX_MS = 5_000;
  let idleWaitMs = IDLE_MIN_MS;
  while (!isStopRequested()) {
    const { mode, pool: resolvedPool } = resolveConnectionPool(getAllSettings());
    const pool = availablePool(resolvedPool);
    const parallel = mode === "parallel" && pool.length > 1;
    // Read every loop like the mode, so toggling the flag applies mid-run.
    const split = parallel && getSetting("llm_split_file") === "1";
    const concurrency = split ? 1 : parallel ? pool.length : 1;
    const waitForOtherFiles = split ? activeJobCount() > 0 : splitJobRunning;

    // In parallel without split, a slot keeps its own connection while it has one,
    // so a new file never pairs with a connection another slot still holds.
    const rank = [...liveSlots].filter((slot) => slot < index).length;
    const turn = parallel && !split && index < pool.length ? index : rank;

    if (turn >= concurrency || waitForOtherFiles) {
      // Not active under the current mode. Stay alive while anything is pending OR
      // in flight, so a mid-run widen to parallel can reactivate this slot; only
      // exit once the queue is fully drained.
      // The active-job count is in memory: check it first so a busy queue never hits the DB.
      if (activeJobCount() === 0 && !hasPendingJobs(filter)) break;
      await delay(idleWaitMs);
      idleWaitMs = Math.min(idleWaitMs * 2, IDLE_MAX_MS);
      continue;
    }
    idleWaitMs = IDLE_MIN_MS;

    const job = claimNextJob(filter);
    if (!job) break;

    const order = parallel && !split ? [pool[turn], ...pool.filter((_, j) => j !== turn)] : pool;
    // Without split, a file stays on its worker's connection and the rest are fallbacks.
    const jobMode: LlmMode = split ? "parallel" : parallel ? "fallback" : mode;
    const primary = order[0];
    const releasePrimary = primary ? await acquireConnectionLock(primary) : undefined;
    let stopped = false;
    try {
      if (isStopRequested()) break;
      // A review can begin while this claimed job waits for its connection.
      if (
        releasePrimary &&
        hasAutomaticTranslationRestrictions() &&
        !isAutomaticTranslationAllowed(job.srt_path, job.video_path ?? undefined, job.task_id)
      ) {
        updateJob(job.id, { status: "pending" });
        claimedJobs.delete(job.id);
        continue;
      }
      splitJobRunning = split;
      stopped = await runJob(job, order, jobMode, primary ? new Set([primary.id]) : new Set<string>(), split);
    } finally {
      splitJobRunning = false;
      releasePrimary?.();
    }
    if (stopped) break;
  }
}

// Auto-scan timer
let scanTimer: ReturnType<typeof setInterval> | null = null;

// A tick that arrives while the previous scan is still walking is skipped: two
// walks at once would double the load for the same answer.
let autoScanRunning = false;

export function startAutoScan(
  intervalMinutes: number,
  scanFn: () => Promise<{ newJobs: number; totalSubtitles: number }>,
) {
  stopAutoScan();
  if (intervalMinutes <= 0) return;

  scanTimer = setInterval(
    () => {
      if (autoScanRunning) return;
      autoScanRunning = true;
      void (async () => {
        try {
          const result = await scanFn();
          // Same announcement as an HTTP scan, so the UI's caches (including
          // the sticky media_scanned flag the checklists read) stay current.
          broadcast("scan:complete", { newJobs: result.newJobs, total: result.totalSubtitles });
          if (result.newJobs > 0) {
            logger.info("scan", `Auto-scan: ${result.newJobs} new files found`);
            if (getSetting("auto_translate") === "1") runQueueSafely();
          }
        } catch (e) {
          logger.error("scan", `Auto-scan error: ${errorMessage(e)}`);
        } finally {
          autoScanRunning = false;
        }
      })();
    },
    intervalMinutes * 60 * 1000,
  );
  logger.info("system", `Auto-scan enabled: every ${intervalMinutes} minutes`);
}

export function stopAutoScan() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}
