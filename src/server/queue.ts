import fs from "node:fs";
import path from "node:path";
import { countPendingJobs, claimPendingJob, updateJob, type JobRow } from "./db.js";
import { getAllSettings, getTask, getSetting } from "./config.js";
import { readSettings } from "./settings-schema.js";
import { resolveConnectionPool, type ResolvedConnection, type LlmMode } from "./connections.js";
import { logger } from "./logger.js";
import { broadcast } from "./sse.js";
import { notify } from "./notify.js";
import { acquireConnectionLock, resetConnectionLocks } from "./connection-lock.js";
import { existingTaskOutput, standardOutputFor } from "./scanner.js";
import { currentTranslationGate, holdQueueStart, takeHeldStart } from "./gpu-gate.js";
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
import { DEFAULT_LLM_ENDPOINT, runJob } from "./queue/run-job.js";
import { writeJobTitle } from "./queue/titles.js";
import { recordUsage } from "./usage.js";

// The per-job state (what translates now, on which connection, what was
// cancelled) lives in ./queue/state.ts; the routes read it through these.
export {
  type JobConnection,
  getActiveJobConnections,
  getActiveJobIds,
  getCurrentJobId,
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

function rememberRunRequest(ids: number[] | undefined): void {
  if (!requestedRun) requestedRun = { ids };
  else if (!requestedRun.ids || !ids) requestedRun = { ids: undefined };
  else requestedRun = { ids: [...new Set([...requestedRun.ids, ...ids])] };
}

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

export function isQueueRunning() {
  return isRunning;
}

export function requestStop() {
  if (isRunning) {
    setStopRequested(true);
    // Abort every in-flight LLM request immediately — don't wait for onProgress
    abortAllJobs("stop_requested");
    logger.info("queue", "Stop requested — aborting in-flight LLM calls");
  }
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
 * Whether a fresh process should pick up the jobs it finds pending. Startup
 * resets jobs left translating by the previous process to pending, and without
 * this nothing restarted them until the next scan or manual start.
 */
export function shouldResumeQueueOnBoot(autoTranslate: string, pendingCount: number): boolean {
  return autoTranslate === "1" && pendingCount > 0;
}

export function resumeQueueOnBoot() {
  const pending = countPendingJobs();
  if (!shouldResumeQueueOnBoot(getSetting("auto_translate"), pending)) return;
  logger.info("queue", `Resuming ${pending} pending job(s) found at startup`);
  runQueueSafely();
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
  if (isRunning) {
    // A run of all jobs already re-checks for pending work before it ends.
    if (runFilter) rememberRunRequest(onlyIds && onlyIds.length > 0 ? onlyIds : undefined);
    return;
  }
  const gate = currentTranslationGate();
  if (!gate.open) {
    holdQueueStart(onlyIds && onlyIds.length > 0 ? onlyIds : undefined);
    logger.info(
      "queue",
      `Translation waits for ${gate.waitingFor} transcription(s) to finish: Whisper and the translation model share one GPU`,
    );
    return;
  }
  isRunning = true;
  resetRunState();
  resetConnectionLocks();

  let filter = onlyIds && onlyIds.length > 0 ? new Set(onlyIds) : null;
  runFilter = filter;
  const pendingCount = countPendingJobs(filter);
  logger.info("queue", `Queue started (${pendingCount} pending jobs${filter ? ", selected subset" : ""})`);

  try {
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
      await Promise.all(Array.from({ length: slots }, (_, i) => adaptiveWorker(i, filter)));
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
  } finally {
    titleRepairJobs.length = 0;
    isRunning = false;
    runFilter = null;
    // A stop ends the run and whatever was asked for during it.
    requestedRun = null;
    resetRunState();
    resetConnectionLocks();
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
function withStandardOutput(job: JobRow): JobRow {
  const task = getTask(job.task_id);
  if (!task) return job;
  const standard = standardOutputFor(job.srt_path, job.output_path, task);
  const outputPath = fs.existsSync(standard) ? standard : (existingTaskOutput(job.srt_path, task) ?? standard);
  if (outputPath === job.output_path) return job;
  updateJob(job.id, { output_path: outputPath });
  return { ...job, output_path: outputPath };
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
    const job = withStandardOutput(claimed);

    if (fs.existsSync(job.output_path) && !job.force) {
      logger.info("queue", `Skipping job ${job.id}: output already exists (${job.output_path})`, job.id);
      updateJob(job.id, { status: "skipped" });
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
  const apiHost = primary.apiHost || settings.llm_endpoint || DEFAULT_LLM_ENDPOINT;
  const requestTimeoutMs = Math.max(5_000, typed.request_timeout_s * 1000);

  for (const job of jobs) {
    if (isStopRequested()) return;
    const task = getTask(job.task_id);
    await writeJobTitle(job, "Title repair", {
      langCode: task?.lang_code || "?",
      targetLang: task?.target_lang || "",
      connection: primary,
      apiHost,
      temperature: typed.temperature,
      disableToolCalls: typed.disable_tool_calls,
      requestTimeoutMs,
      onUsage: (u) => recordUsage({ ...u, jobId: job.id, srtName: path.basename(job.srt_path) }),
    });
  }
}

function hasPendingJobs(filter: Set<number> | null): boolean {
  return countPendingJobs(filter) > 0;
}

/**
 * Adaptive worker. Each loop re-resolves the current LLM mode + pool so a mode
 * change applies mid-run:
 *  - parallel (pool > 1): worker `index` pins connection pool[index] and claims
 *    the next file (work-stealing); the other connections act as per-file fallbacks.
 *  - single / fallback: only worker 0 runs (sequential, one file at a time); the
 *    rest idle. If the mode later widens to parallel, idle workers pick up jobs.
 * A worker exits when the queue is drained (or stop is requested).
 */
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
    const concurrency = parallel ? pool.length : 1;

    if (index >= concurrency) {
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

    const order = parallel ? [pool[index], ...pool.filter((_, j) => j !== index)] : pool;
    const jobMode: LlmMode = parallel ? "fallback" : mode;
    const primary = order[0];
    const releasePrimary = primary ? await acquireConnectionLock(primary) : undefined;
    let stopped = false;
    try {
      stopped = await runJob(job, order, jobMode, primary ? new Set([primary.id]) : new Set<string>());
    } finally {
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
