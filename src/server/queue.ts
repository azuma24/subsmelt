import fs from "node:fs";
import { getJobs, updateJob, getJob } from "./db.js";
import { getAllSettings, getTask, getSetting } from "./config.js";
import { summarizeTranslationError, translateFile } from "./translator.js";
import { logger } from "./logger.js";
import { broadcast } from "./sse.js";

let isRunning = false;
let shouldStop = false;
let currentJobId: number | null = null;

export function isQueueRunning() {
  return isRunning;
}

export function getCurrentJobId() {
  return currentJobId;
}

export function requestStop() {
  if (isRunning) {
    shouldStop = true;
    logger.info("queue", "Stop requested — will finish current job then halt");
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
    while (!shouldStop) {
      // Get oldest pending job (optionally filtered to the selected subset)
      const allJobs = getJobs("pending") as any[];
      const pendingJobs = filter ? allJobs.filter((j) => filter.has(j.id)) : allJobs;
      if (pendingJobs.length === 0) break;

      // getJobs("pending") returns sorted by priority DESC, created_at ASC
      // so first item is the highest priority
      const job = pendingJobs[0];
      currentJobId = job.id;

      // Pre-check: if output exists and force is not set, skip
      if (fs.existsSync(job.output_path) && !job.force) {
        logger.info("queue", `Skipping job ${job.id}: output already exists (${job.output_path})`, job.id);
        updateJob(job.id, { status: "skipped" });
        currentJobId = null;
        continue;
      }

      const srtName = job.srt_path.split("/").pop() || job.srt_path;
      const task = getTask(job.task_id);
      const langCode = task?.lang_code || "?";
      const targetLang = task?.target_lang || "";

      logger.info("queue", `Started: ${srtName} → ${langCode} (job #${job.id})`, job.id);
      updateJob(job.id, { status: "translating", error: null, analysis_context: null });
      broadcast("job:start", { jobId: job.id, srtName, langCode });

      const settings = getAllSettings();
      const startTime = Date.now();

      try {
        const promptToUse = task?.prompt_override || settings.prompt || "";
        await translateFile({
          srtPath: job.srt_path,
          outputPath: job.output_path,
          apiKey: settings.api_key || "",
          apiHost: settings.llm_endpoint || "http://localhost:8000/v1",
          model: settings.model || "",
          prompt: promptToUse,
          lang: targetLang || "Traditional Chinese (Taiwan)",
          additional: settings.additional_context || "",
          temperature: parseFloat(settings.temperature || "0.7"),
          chunkSize: parseInt(settings.chunk_size || "20", 10),
          contextSize: parseInt(settings.context_window || "5", 10),
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
        });

        const durStr = formatDuration(durationSeconds);
        logger.info(
          "translate",
          `Completed: ${srtName} → ${langCode} in ${durStr} (${job.total_cues || "?"} cues)`,
          job.id
        );
        broadcast("job:done", { jobId: job.id, durationSeconds, srtName, langCode: langCode });
      } catch (error: any) {
        const durationSeconds = (Date.now() - startTime) / 1000;
        if (error.message === "STOP_REQUESTED" || shouldStop) {
          // Graceful stop — reset job to pending so it can resume later
          updateJob(job.id, { status: "pending", error: null, duration_seconds: durationSeconds });
          logger.info("queue", `Job #${job.id} interrupted by stop request — reset to pending`, job.id);
          broadcast("job:stopped", { jobId: job.id, srtName });
          break;
        }

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
        });
        broadcast("job:error", { jobId: job.id, error: compactError, srtName });
      }

      currentJobId = null;
    }

    if (shouldStop) {
      logger.info("queue", "Queue stopped by user request");
      broadcast("queue:stopped", {});
    } else {
      logger.info("queue", "Queue finished — no more pending jobs");
      broadcast("queue:finished", {});
    }
  } finally {
    isRunning = false;
    shouldStop = false;
    currentJobId = null;
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
