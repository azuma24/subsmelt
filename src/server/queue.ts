import fs from "node:fs";
import { getJobs, updateJob, getJob } from "./db.js";
import { getAllSettings, getTask, getSetting } from "./config.js";
import { summarizeTranslationError, translateFile, probeModelContext } from "./translator.js";
import { resolveConnectionPool, type ResolvedConnection, type LlmMode } from "./connections.js";
import { logger } from "./logger.js";
import { broadcast } from "./sse.js";
import { notify } from "./notify.js";

let isRunning = false;
let shouldStop = false;
let currentJobId: number | null = null;
// Jobs translating right now (one per active worker in parallel mode).
const activeJobIds = new Set<number>();
// One AbortController per in-flight job; requestStop() aborts them all.
const abortControllers = new Set<AbortController>();
// Hard ceiling on concurrent translation workers (matches the per-file connection cap).
const MAX_WORKERS = 32;

export function isQueueRunning() {
  return isRunning;
}

export function getCurrentJobId() {
  return currentJobId;
}

export function getActiveJobIds(): number[] {
  return Array.from(activeJobIds);
}

export function requestStop() {
  if (isRunning) {
    shouldStop = true;
    // Abort every in-flight LLM request immediately — don't wait for onProgress
    for (const controller of abortControllers) controller.abort("stop_requested");
    logger.info("queue", "Stop requested — aborting in-flight LLM calls");
  }
}

export async function processQueue(onlyIds?: number[]) {
  if (isRunning) return;
  isRunning = true;
  shouldStop = false;

  const filter = onlyIds && onlyIds.length > 0 ? new Set(onlyIds) : null;
  const allPending = getJobs("pending") as any[];
  const pendingCount = filter ? allPending.filter((j) => filter.has(j.id)).length : allPending.length;
  logger.info("queue", `Queue started (${pendingCount} pending jobs${filter ? ", selected subset" : ""})`);

  try {
    // Adaptive worker pool: every worker re-resolves the LLM mode on each job
    // claim, so switching Single/Fallback ⇄ Parallel takes effect mid-run without
    // restarting the queue. One slot per configured connection (capped); a slot
    // only processes when the current mode permits its index (see adaptiveWorker).
    const { all } = resolveConnectionPool(getAllSettings());
    const slots = Math.max(1, Math.min(MAX_WORKERS, all.length || 1));
    logger.info(
      "queue",
      `Worker pool: up to ${slots} slot${slots === 1 ? "" : "s"} (adaptive to LLM mode)`,
      null,
      { stage: "worker_pool" }
    );
    await Promise.all(Array.from({ length: slots }, (_, i) => adaptiveWorker(i, filter)));

    if (shouldStop) {
      logger.info("queue", "Queue stopped by user request");
      broadcast("queue:stopped", {});
      void notify("queue:stopped", {});
    } else {
      logger.info("queue", "Queue finished — no more pending jobs");
      broadcast("queue:finished", {});
      void notify("queue:finished", {});
    }
  } finally {
    isRunning = false;
    shouldStop = false;
    currentJobId = null;
    activeJobIds.clear();
    abortControllers.clear();
  }
}

/**
 * Atomically claim the next pending job. Synchronous on purpose: better-sqlite3
 * calls don't yield, so concurrent pool workers can never read-then-mark the
 * same job. Returns null when the queue is drained (or stop was requested).
 * Skipped (output-exists) jobs are consumed here and the next one is tried.
 */
function claimNextJob(filter: Set<number> | null): any | null {
  while (!shouldStop) {
    const all = getJobs("pending") as any[];
    const pending = filter ? all.filter((j) => filter.has(j.id)) : all;
    if (pending.length === 0) return null;

    // Sorted by priority DESC, created_at ASC — first item is highest priority.
    const job = pending[0];

    if (fs.existsSync(job.output_path) && !job.force) {
      logger.info("queue", `Skipping job ${job.id}: output already exists (${job.output_path})`, job.id);
      updateJob(job.id, { status: "skipped" });
      continue;
    }

    updateJob(job.id, { status: "translating", error: null, analysis_context: null, used_connections: null });
    activeJobIds.add(job.id);
    currentJobId = job.id;
    return job;
  }
  return null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function hasPendingJobs(filter: Set<number> | null): boolean {
  const all = getJobs("pending") as any[];
  return (filter ? all.filter((j) => filter.has(j.id)) : all).length > 0;
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
  while (!shouldStop) {
    const { mode, pool } = resolveConnectionPool(getAllSettings());
    const parallel = mode === "parallel" && pool.length > 1;
    const concurrency = parallel ? pool.length : 1;

    if (index >= concurrency) {
      // Not active under the current mode. Stay alive while anything is pending OR
      // in flight, so a mid-run widen to parallel can reactivate this slot; only
      // exit once the queue is fully drained.
      if (!hasPendingJobs(filter) && activeJobIds.size === 0) break;
      await delay(500);
      continue;
    }

    const job = claimNextJob(filter);
    if (!job) break;

    const order = parallel
      ? [pool[index], ...pool.filter((_, j) => j !== index)]
      : pool;
    const jobMode: LlmMode = parallel ? "fallback" : mode;
    const stopped = await runJob(job, order, jobMode);
    if (stopped) break;
  }
}

/**
 * Translate one job using the supplied connection list (first = primary).
 * Returns true when the job was interrupted by a stop request so the caller
 * can break its loop.
 */
async function runJob(job: any, conns: ResolvedConnection[], llmModeForJob: LlmMode): Promise<boolean> {
  const srtName = job.srt_path.split("/").pop() || job.srt_path;
  const task = getTask(job.task_id);
  const langCode = task?.lang_code || "?";
  const targetLang = task?.target_lang || "";

  logger.info("queue", `Started: ${srtName} → ${langCode} (job #${job.id})`, job.id);
  broadcast("job:start", { jobId: job.id, srtName, langCode });

  const settings = getAllSettings();
  const startTime = Date.now();

  // Per-job abort controller — aborted immediately by requestStop()
  const jobAbort = new AbortController();
  abortControllers.add(jobAbort);

  const usedConnLabels: string[] = [];
  const usedConnIds = new Set<string>();

  try {
    if (conns.length === 0) throw new Error("No usable LLM connection configured");
    const promptToUse = task?.prompt_override || settings.prompt || "";

    const primary = conns[0];
    const apiHost = primary.apiHost || settings.llm_endpoint || "http://localhost:8000/v1";
    const apiKey = primary.apiKey || "";
    const model = primary.model || "";
    logger.info("queue", `LLM mode: ${llmModeForJob} (${conns.length} connection${conns.length === 1 ? "" : "s"}) — primary ${primary.label}`, job.id, { stage: "llm_pool" });

    const chunkSize = parseInt(settings.chunk_size || "20", 10);
    const configuredParallel = Math.max(1, Math.min(8, parseInt(settings.parallel_chunks || "1", 10)));

    // Probe model context window (LM Studio only — graceful no-op elsewhere).
    const ctxInfo = await probeModelContext(apiHost, model, chunkSize);
    const parallelChunks = configuredParallel > 1
      ? configuredParallel  // user explicitly set parallel — respect it
      : ctxInfo.recommendedParallelChunks;

    const requestTimeoutMs = Math.max(
      5_000,
      parseInt(settings.request_timeout_s || "300", 10) * 1000
    );

    logger.info("queue", `Model context probe: maxCtx=${ctxInfo.maxContextTokens ?? "unknown"} analysisLines=${ctxInfo.recommendedAnalysisLines} parallelChunks=${parallelChunks} timeoutMs=${requestTimeoutMs}`, job.id, { stage: "context_probe" });

    await translateFile({
      srtPath: job.srt_path,
      outputPath: job.output_path,
      apiKey,
      apiHost,
      model,
      provider: primary.provider,
      connections: conns,
      llmMode: llmModeForJob,
      onConnectionUsed: ({ id, label }) => {
        logger.info("translate", `Using LLM connection: ${label} (${id})`, job.id, { stage: "llm_connection" });
        if (!usedConnIds.has(id)) {
          usedConnIds.add(id);
          usedConnLabels.push(label);
        }
      },
      onConnectionError: ({ id, label, error }) => {
        logger.warn("translate", `LLM connection failed, cascading to next: ${label} (${id}) — ${error}`, job.id, { stage: "llm_connection_error" });
      },
      prompt: promptToUse,
      lang: targetLang || "English",
      sourceLang: task?.source_lang || "Automatic",
      additional: settings.additional_context || "",
      temperature: parseFloat(settings.temperature || "0.7"),
      chunkSize,
      contextSize: parseInt(settings.context_window || "5", 10),
      parallelChunks,
      maxAnalysisLines: ctxInfo.recommendedAnalysisLines,
      requestTimeoutMs,
      disableToolCalls: settings.disable_tool_calls === "1",
      refinePass: settings.refine_pass === "1",
      seriesMemory: settings.series_memory === "1",
      abortSignal: jobAbort.signal,
      onProgress: (completed, total) => {
        if (shouldStop) throw new Error("STOP_REQUESTED");
        updateJob(job.id, {
          completed_cues: completed,
          total_cues: total,
        });
        broadcast("job:progress", {
          jobId: job.id,
          completed,
          total,
          pct: total > 0 ? Math.round((completed / total) * 100) : 0,
        });
      },
      onRetry: (attempt, error, backoff) => {
        const diagnostics = summarizeTranslationError(error);
        logger.warn(
          "translate",
          `Retry ${attempt}/5: ${diagnostics.message} (backoff ${backoff}ms)`,
          job.id,
          {
            stage: "translate_retry",
            status: diagnostics.status,
            code: diagnostics.code,
            responseSnippet: diagnostics.responseSnippet,
            causeMessage: diagnostics.causeMessage,
          }
        );
      },
      onAnalysis: (analysis) => {
        updateJob(job.id, { analysis_context: analysis });
        logger.info("translate", `Context prepared for ${srtName} (${langCode})`, job.id, {
          stage: "context_analysis",
          preview: analysis.slice(0, 300),
        });
        broadcast("job:analysis", { jobId: job.id, analysis, srtName });
      },
    });

    const durationSeconds = (Date.now() - startTime) / 1000;
    updateJob(job.id, {
      status: "done",
      duration_seconds: durationSeconds,
      force: 0,
      used_connections: usedConnLabels.join(", ") || null,
    });

    const durStr = formatDuration(durationSeconds);
    logger.info(
      "translate",
      `Completed: ${srtName} → ${langCode} in ${durStr} (${job.total_cues || "?"} cues)`,
      job.id
    );
    broadcast("job:done", { jobId: job.id, durationSeconds, srtName, langCode });
    void notify("job:done", { jobId: job.id, durationSeconds, srtName, langCode });
    return false;
  } catch (error: any) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    if (error.message === "STOP_REQUESTED" || shouldStop) {
      // Graceful stop — reset job to pending so it can resume later
      updateJob(job.id, { status: "pending", error: null, duration_seconds: durationSeconds });
      logger.info("queue", `Job #${job.id} interrupted by stop request — reset to pending`, job.id);
      broadcast("job:stopped", { jobId: job.id, srtName });
      return true;
    }

    // Log raw error shape to help debug "Unknown translation error" cases
    logger.info(
      "translate",
      `Raw error: name=${error?.name} constructor=${error?.constructor?.name} message=${JSON.stringify(error?.message)} statusCode=${error?.statusCode ?? error?.status}`,
      job.id
    );
    const diagnostics = summarizeTranslationError(error);
    const compactError = summarizeJobErrorForStorage(
      diagnostics.message,
      diagnostics.responseSnippet,
      diagnostics.causeMessage,
    );

    logger.error(
      "translate",
      `Failed: ${srtName} → ${langCode}: ${diagnostics.message}`,
      job.id,
      {
        stage: "translate_failure",
        status: diagnostics.status,
        code: diagnostics.code,
        responseSnippet: diagnostics.responseSnippet,
        causeMessage: diagnostics.causeMessage,
        endpoint: sanitizeEndpoint(settings.llm_endpoint || "http://localhost:8000/v1"),
        model: settings.model || "",
        chunkSize: parseInt(settings.chunk_size || "20", 10),
        contextSize: parseInt(settings.context_window || "5", 10),
        temperature: parseFloat(settings.temperature || "0.7"),
        srtPath: job.srt_path,
        outputPath: job.output_path,
      }
    );
    updateJob(job.id, {
      status: "error",
      error: compactError,
      duration_seconds: durationSeconds,
      used_connections: usedConnLabels.length > 0 ? usedConnLabels.join(", ") : null,
    });
    broadcast("job:error", { jobId: job.id, error: compactError, srtName });
    void notify("job:error", { jobId: job.id, error: compactError, srtName, langCode });
    return false;
  } finally {
    abortControllers.delete(jobAbort);
    activeJobIds.delete(job.id);
    currentJobId = activeJobIds.size > 0 ? Array.from(activeJobIds)[activeJobIds.size - 1] : null;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

function sanitizeEndpoint(endpoint: string): string {
  return endpoint.replace(/:\/\/[^@\s]+@/, "://***@");
}

function summarizeJobErrorForStorage(base: string, responseSnippet?: string, causeMessage?: string): string {
  const lines = [base];
  if (responseSnippet) lines.push(`response: ${responseSnippet}`);
  if (causeMessage) lines.push(`cause: ${causeMessage}`);
  const combined = lines.join("\n");
  return combined.length > 2000 ? `${combined.slice(0, 2000)}…` : combined;
}

// Auto-scan timer
let scanTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoScan(
  intervalMinutes: number,
  scanFn: () => { newJobs: number }
) {
  stopAutoScan();
  if (intervalMinutes <= 0) return;

  scanTimer = setInterval(
    () => {
      try {
        const { newJobs } = scanFn();
        if (newJobs > 0) {
          logger.info("scan", `Auto-scan: ${newJobs} new files found`);
          if (getSetting("auto_translate") === "1") processQueue();
        }
      } catch (e: any) {
        logger.error("scan", `Auto-scan error: ${e.message}`);
      }
    },
    intervalMinutes * 60 * 1000
  );
  logger.info("system", `Auto-scan enabled: every ${intervalMinutes} minutes`);
}

export function stopAutoScan() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}
