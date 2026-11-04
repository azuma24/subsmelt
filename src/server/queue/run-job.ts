import { addJobUsage, updateJob, type JobRow } from "../db.js";
import { getAllSettings, getTask } from "../config.js";
import { readSettings, type TypedSettings } from "../settings-schema.js";
import type { TranslationTask } from "../../shared/tasks.js";
import { summarizeTranslationError, translateFile, type UsageEvent } from "../translator.js";
import { planTranslation, type TranslationPlan } from "../translator/plan.js";
import { recordUsage } from "../usage.js";
import type { LlmMode, ResolvedConnection } from "../connections.js";
import { logger } from "../logger.js";
import { broadcast } from "../sse.js";
import { notify } from "../notify.js";
import { tryAcquireConnectionLock } from "../connection-lock.js";
import { llmBusyWithTranscription } from "../gpu-gate.js";
import { MEDIA_DIR } from "../scanner.js";
import { assertMediaPathAllowed } from "../transcription-client.js";
import { errorClassName, errorMessage, errorName, errorStatus } from "../errors.js";
import {
  isJobCancelled,
  isStopRequested,
  markConnectionOffline,
  registerAbort,
  releaseJob,
  setJobAnalyzing,
  setJobConnection,
  setSplitJobConnections,
  dropSplitJobConnection,
  getJobConnection,
} from "./state.js";
import { writeJobTitle } from "./titles.js";
import { workKey } from "../translator/work-key.js";

// Progress (completed_cues) is written to SQLite on every cue-advance, which with
// many workers and long files hammers the WAL. Batch it — at most one write per
// interval per job — while always forcing the final write so the stored count is
// exact. The SSE progress broadcast rides the same cadence.
const PROGRESS_WRITE_THROTTLE_MS = 250;

/** Everything one job's stages share, built once when the job starts. */
interface JobContext {
  job: JobRow;
  /** The file name shown in logs and events. */
  srtName: string;
  task: TranslationTask | undefined;
  langCode: string;
  targetLang: string;
  conns: ResolvedConnection[];
  llmMode: LlmMode;
  reservedConnectionIds: Set<string>;
  /** llm_split_file: this file's chunks go to every connection at once. */
  splitFile: boolean;
  settings: Record<string, string>;
  typed: TypedSettings;
  startTime: number;
  /** Aborted by a queue stop or a cancel of this job. */
  abort: AbortController;
  /** Connections that produced translations, in first-use order. */
  usedConnLabels: string[];
  usedConnIds: Set<string>;
  // Latest cue total seen from onProgress. `job` is the row as claimed, so
  // reading job.total_cues after the run would print "?" — the DB was updated,
  // the local object was not.
  lastTotalCues: number;
  // Throttled progress write timestamp (see PROGRESS_WRITE_THROTTLE_MS).
  lastProgressWrite: number;
}

/** The job's primary connection, prompt and translation plan. */
interface JobPlan {
  primary: ResolvedConnection;
  prompt: string;
  translation: TranslationPlan;
}

/**
 * Translate one job using the supplied connection list (first = primary).
 * Returns true when the job was interrupted by a stop request so the caller
 * can break its loop.
 */
export async function runJob(
  job: JobRow,
  conns: ResolvedConnection[],
  llmMode: LlmMode,
  reservedConnectionIds: Set<string> = new Set(),
  splitFile = false,
): Promise<boolean> {
  const ctx = beginJob(job, conns, llmMode, reservedConnectionIds, splitFile);
  try {
    const plan = await planJob(ctx);
    await translateJob(ctx, plan);
    settleJob(ctx);
    if (ctx.typed.title_sidecar) await translateJobTitle(ctx, plan);
    return false;
  } catch (error) {
    return failJob(ctx, error);
  } finally {
    releaseJob(job.id, ctx.abort);
  }
}

/** Announces the job and registers the controller its LLM calls abort through. */
function beginJob(
  job: JobRow,
  conns: ResolvedConnection[],
  llmMode: LlmMode,
  reservedConnectionIds: Set<string>,
  splitFile: boolean,
): JobContext {
  const srtName = job.srt_path.split("/").pop() || job.srt_path;
  const task = getTask(job.task_id);
  const langCode = task?.lang_code || "?";
  const targetLang = task?.target_lang || "";

  logger.info("queue", `Started: ${srtName} → ${langCode} (job #${job.id})`, job.id);
  broadcast("job:start", { jobId: job.id, srtName, langCode });

  const abort = new AbortController();
  registerAbort(job.id, abort);

  return {
    job,
    srtName,
    task,
    langCode,
    targetLang,
    conns,
    llmMode,
    reservedConnectionIds,
    splitFile,
    settings: getAllSettings(),
    typed: readSettings(),
    startTime: Date.now(),
    abort,
    usedConnLabels: [],
    usedConnIds: new Set(),
    lastTotalCues: 0,
    lastProgressWrite: 0,
  };
}

/**
 * Checks the job can run at all, picks the primary connection and probes every
 * connection's context window so the chunk parallelism fits the model.
 */
async function planJob(ctx: JobContext): Promise<JobPlan> {
  const { job, task, conns, settings, typed } = ctx;
  if (!task) throw new Error(`Translation task #${job.task_id} no longer exists`);
  if (conns.length === 0) throw new Error("No usable LLM connection configured");
  // Same boundary the routes enforce on preview/cues/download: DB-stored
  // paths still hit the filesystem here, so confirm they stay under MEDIA_DIR
  // before translating (a traversal output_pattern would otherwise write
  // anywhere the job runs).
  assertMediaPathAllowed(job.srt_path, MEDIA_DIR);
  if (job.output_path) assertMediaPathAllowed(job.output_path, MEDIA_DIR);

  const primary = conns[0];
  setJobConnection(job.id, { id: primary.id, label: primary.label, host: primary.apiHost, model: primary.model });
  logger.info(
    "queue",
    `LLM mode: ${ctx.llmMode} (${conns.length} connection${conns.length === 1 ? "" : "s"}) — primary ${primary.label}`,
    job.id,
    { stage: "llm_pool" },
  );

  const translation = await planTranslation(conns, typed, ctx.abort.signal);
  const { parallelChunks, requestTimeoutMs } = translation.options;
  const probes = conns
    .map((c) => {
      const info = translation.contexts.get(c.id);
      return `${c.label} maxCtx=${info?.maxContextTokens ?? "unknown"} analysisLines=${info?.recommendedAnalysisLines}`;
    })
    .join("; ");
  const configured = translation.configuredParallel;
  const capped = parallelChunks < configured ? ` (capped from ${configured} to fit the context window)` : "";
  logger.info(
    "queue",
    `Model context probe: ${probes}; parallelChunks=${parallelChunks}${capped} timeoutMs=${requestTimeoutMs}`,
    job.id,
    { stage: "context_probe" },
  );

  return { primary, prompt: task.prompt_override || settings.prompt || "", translation };
}

/** Asks the GPU gate before each chunk, logging when a connection's machine turns busy or free. */
function busyWithTranscription(jobId: number, conns: ResolvedConnection[]): (conn: ResolvedConnection) => boolean {
  const wasBusy = new Map<string, boolean>();
  return (conn) => {
    const busy = llmBusyWithTranscription(conn);
    if (conns.length > 1 && (wasBusy.get(conn.id) ?? false) !== busy) {
      const message = busy
        ? `Transcription running on ${conn.label}'s machine — sending chunks to the next connection`
        : `Transcription finished — ${conn.label} is preferred again`;
      logger.info("translate", message, jobId, { stage: "llm_busy" });
    }
    wasBusy.set(conn.id, busy);
    return busy;
  };
}

/** Runs the translation engine over the file, relaying its events to the log, the DB and SSE. */
async function translateJob(ctx: JobContext, plan: JobPlan): Promise<void> {
  const { job, srtName, langCode, conns, typed } = ctx;
  if (ctx.splitFile) {
    setSplitJobConnections(
      job.id,
      conns.map((c) => ({ id: c.id, label: c.label, host: c.apiHost, model: c.model })),
    );
  }
  const key = workKey(job.srt_path, [
    ctx.targetLang,
    ctx.task?.source_lang || "",
    plan.prompt,
    plan.translation.options.additional,
    String(plan.translation.options.refinePass),
  ]);
  const savedAnalysis = key && job.analysis_work_key === key ? job.analysis_context : null;
  if (savedAnalysis) {
    logger.info("translate", `Reusing the saved analysis of ${srtName}`, job.id, { stage: "context_analysis_reused" });
  } else if (job.analysis_context) {
    updateJob(job.id, { analysis_context: null, analysis_work_key: null });
  }
  await translateFile({
    srtPath: job.srt_path,
    outputPath: job.output_path,
    ...plan.translation.options,
    llmMode: ctx.llmMode,
    split: ctx.splitFile ? { limits: plan.translation.parallelByConnection } : undefined,
    onConnectionUsed: ({ id, label }) => {
      logger.info("translate", `Using LLM connection: ${label} (${id})`, job.id, { stage: "llm_connection" });
      if (!ctx.usedConnIds.has(id)) {
        ctx.usedConnIds.add(id);
        ctx.usedConnLabels.push(label);
      }
    },
    onConnectionActive: ({ id, label }) => {
      // A fallback switch, or a return to an earlier connection, moves the
      // job to another machine; keep the dashboard's attribution current.
      // A split job uses every connection at once, so its reported primary stays put.
      if (ctx.splitFile) return;
      const switched = conns.find((c) => c.id === id);
      if (switched) setJobConnection(job.id, { id, label, host: switched.apiHost, model: switched.model });
    },
    onConnectionError: ({ id, label, error }) => {
      logger.warn("translate", `LLM connection failed, cascading to next: ${label} (${id}) — ${error}`, job.id, {
        stage: "llm_connection_error",
      });
    },
    onConnectionUnavailable: ({ id, label, error }) => {
      markConnectionOffline(id);
      dropSplitJobConnection(job.id, id);
      logger.warn(
        "translate",
        `LLM connection unavailable after 5 attempts; skipping for this queue run: ${label} (${id}) — ${error}`,
        job.id,
        { stage: "llm_connection_unavailable" },
      );
    },
    onConnectionDropped: ({ id, label, error }) => {
      dropSplitJobConnection(job.id, id);
      logger.warn("translate", `LLM connection dropped for the rest of this job: ${label} (${id}) — ${error}`, job.id, {
        stage: "llm_connection_dropped",
      });
    },
    // Only cascades reach this (the primary is reserved by the worker); they
    // must not block on another worker's job-long hold.
    acquireConnection: tryAcquireConnectionLock,
    reservedConnectionIds: ctx.reservedConnectionIds,
    isConnectionBusy: busyWithTranscription(job.id, conns),
    prompt: plan.prompt,
    lang: ctx.targetLang || "English",
    sourceLang: ctx.task?.source_lang || "Automatic",
    seriesMemory: typed.series_memory,
    abortSignal: ctx.abort.signal,
    onProgress: (completed, total) => recordProgress(ctx, completed, total),
    onRetry: (attempt, error, backoff, maxRetries) => {
      const diagnostics = summarizeTranslationError(error);
      logger.warn(
        "translate",
        `Retry ${attempt}/${maxRetries ?? "?"}: ${diagnostics.message} (backoff ${backoff}ms)`,
        job.id,
        {
          stage: "translate_retry",
          status: diagnostics.status,
          code: diagnostics.code,
          responseSnippet: diagnostics.responseSnippet,
          causeMessage: diagnostics.causeMessage,
        },
      );
    },
    onUsage: (u) => recordJobUsage(ctx, u),
    savedAnalysis: savedAnalysis ?? undefined,
    onAnalysisPhase: (running) => setJobAnalyzing(job.id, running),
    onAnalysis: (analysis) => {
      updateJob(job.id, { analysis_context: analysis, analysis_work_key: key });
      logger.info("translate", `Context prepared for ${srtName} (${langCode})`, job.id, {
        stage: "context_analysis",
        preview: analysis.slice(0, 300),
      });
      broadcast("job:analysis", { jobId: job.id, analysis, srtName });
    },
  });
}

/**
 * A progress tick from the engine. A stop or a cancel surfaces here as a
 * thrown marker error, which the engine lets through to failJob.
 */
function recordProgress(ctx: JobContext, completed: number, total: number): void {
  const { job } = ctx;
  if (isStopRequested()) throw new Error("STOP_REQUESTED");
  if (isJobCancelled(job.id)) throw new Error("JOB_CANCELLED");
  ctx.lastTotalCues = total;
  // Skip the DB write + broadcast on intermediate ticks; always land the
  // final tick so the stored completed_cues is exact when the job settles.
  const now = Date.now();
  if (completed < total && now - ctx.lastProgressWrite < PROGRESS_WRITE_THROTTLE_MS) return;
  ctx.lastProgressWrite = now;
  updateJob(job.id, { completed_cues: completed, total_cues: total });
  broadcast("job:progress", {
    jobId: job.id,
    completed,
    total,
    pct: total > 0 ? Math.round((completed / total) * 100) : 0,
  });
}

/** Marks the job done and tells the UI and the notifier. */
function settleJob(ctx: JobContext): void {
  const { job, srtName, langCode } = ctx;
  // A cancel landing while the last LLM call already resolved must not end
  // as "done" — the user asked for this job to stop.
  if (isJobCancelled(job.id)) throw new Error("JOB_CANCELLED");
  const durationSeconds = (Date.now() - ctx.startTime) / 1000;
  updateJob(job.id, {
    status: "done",
    duration_seconds: durationSeconds,
    force: 0,
    used_connections: ctx.usedConnLabels.join(", ") || null,
  });
  logger.info(
    "translate",
    `Completed: ${srtName} → ${langCode} in ${formatDuration(durationSeconds)} (${ctx.lastTotalCues || job.total_cues || "?"} cues)`,
    job.id,
  );
  broadcast("job:done", { jobId: job.id, durationSeconds, srtName, langCode });
  void notify("job:done", { jobId: job.id, durationSeconds, srtName, langCode });
}

/** Counts one LLM call toward the job's live totals and the usage ledger. */
function recordJobUsage(ctx: JobContext, usage: UsageEvent): void {
  addJobUsage(ctx.job.id, usage.inputTokens, usage.outputTokens);
  recordUsage({ ...usage, jobId: ctx.job.id, src: ctx.job.srt_path, srtName: ctx.srtName });
}

/** Translates the media title into the folder's sidecar on the job's primary connection. */
async function translateJobTitle(ctx: JobContext, plan: JobPlan): Promise<void> {
  const { job, typed } = ctx;
  await writeJobTitle(job, "Title sidecar", {
    langCode: ctx.langCode,
    targetLang: ctx.targetLang,
    // A split job may have lost its primary by now; it reports the one still working.
    connection: (ctx.splitFile && ctx.conns.find((c) => c.id === getJobConnection(job.id)?.id)) || plan.primary,
    temperature: typed.temperature,
    disableToolCalls: typed.disable_tool_calls,
    requestTimeoutMs: plan.translation.options.requestTimeoutMs,
    // The job was re-run on purpose, so the cached title goes too.
    force: !!job.force,
    abortSignal: ctx.abort.signal,
    onUsage: (u) => recordJobUsage(ctx, u),
  });
}

/**
 * Ends a job that did not finish: cancelled by the user (terminal error),
 * interrupted by a queue stop (back to pending; returns true) or failed.
 */
function failJob(ctx: JobContext, error: unknown): boolean {
  const { job, srtName, langCode, typed } = ctx;
  const durationSeconds = (Date.now() - ctx.startTime) / 1000;
  const message = errorMessage(error);
  // A stop wins over a cancel: every interrupted job goes back to pending,
  // none gets picked out as "Cancelled by user".
  if (!isStopRequested() && (message === "JOB_CANCELLED" || isJobCancelled(job.id))) {
    // A user cancel is terminal: the job ends as a cancelled error (Retry is
    // offered from there) instead of returning to the queue. The partial
    // output stays on disk, so a later retry resumes from it.
    updateJob(job.id, { status: "error", error: "Cancelled by user", duration_seconds: durationSeconds });
    logger.info("queue", `Job #${job.id} cancelled by user`, job.id);
    broadcast("job:cancelled", { jobId: job.id, srtName });
    return false;
  }
  if (message === "STOP_REQUESTED" || isStopRequested()) {
    // Graceful stop — reset job to pending so it can be picked up later. The
    // next run starts the file over, so the progress count goes back to zero.
    updateJob(job.id, { status: "pending", completed_cues: 0, error: null, duration_seconds: durationSeconds });
    logger.info("queue", `Job #${job.id} interrupted by stop request — reset to pending`, job.id);
    broadcast("job:stopped", { jobId: job.id, srtName });
    return true;
  }

  // Log raw error shape to help debug "Unknown translation error" cases
  logger.info(
    "translate",
    `Raw error: name=${errorName(error)} constructor=${errorClassName(error)} message=${JSON.stringify(message)} statusCode=${errorStatus(error)}`,
    job.id,
  );
  const diagnostics = summarizeTranslationError(error);
  const compactError = summarizeJobErrorForStorage(
    diagnostics.message,
    diagnostics.responseSnippet,
    diagnostics.causeMessage,
  );
  logger.error("translate", `Failed: ${srtName} → ${langCode}: ${diagnostics.message}`, job.id, {
    stage: "translate_failure",
    status: diagnostics.status,
    code: diagnostics.code,
    responseSnippet: diagnostics.responseSnippet,
    causeMessage: diagnostics.causeMessage,
    // The primary: the legacy llm_endpoint/model keys are stale once connections exist.
    endpoint: sanitizeEndpoint(ctx.conns[0]?.apiHost ?? ""),
    model: ctx.conns[0]?.model ?? "",
    chunkSize: typed.chunk_size,
    contextSize: typed.context_window,
    temperature: typed.temperature,
    srtPath: job.srt_path,
    outputPath: job.output_path,
  });
  updateJob(job.id, {
    status: "error",
    error: compactError,
    duration_seconds: durationSeconds,
    used_connections: ctx.usedConnLabels.length > 0 ? ctx.usedConnLabels.join(", ") : null,
  });
  broadcast("job:error", { jobId: job.id, error: compactError, srtName });
  void notify("job:error", { jobId: job.id, error: compactError, srtName, langCode });
  return false;
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

/** The error text stored on the job row: message, response and cause, capped. */
function summarizeJobErrorForStorage(base: string, responseSnippet?: string, causeMessage?: string): string {
  const lines = [base];
  if (responseSnippet) lines.push(`response: ${responseSnippet}`);
  if (causeMessage) lines.push(`cause: ${causeMessage}`);
  const combined = lines.join("\n");
  return combined.length > 2000 ? `${combined.slice(0, 2000)}…` : combined;
}
