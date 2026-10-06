import type { Express, Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { getTasks, getTask } from "../config.js";
import {
  getJobs,
  getJobsForList,
  countPendingJobs,
  getJob,
  resetJob,
  resetJobs,
  forceJob,
  forceJobs,
  forceAllJobs,
  deleteJob,
  deleteJobs,
  clearFinishedJobs,
  pinJob,
  unpinJob,
  reorderJobs,
  type JobRow,
} from "../db.js";
import { MEDIA_DIR } from "../scanner.js";
import {
  runQueueSafely,
  isQueueRunning,
  getCurrentJobId,
  requestStop,
  requestJobCancel,
  getJobConnection,
  getActiveJobConnections,
} from "../queue.js";
import {
  parseSubtitle,
  readSubtitleFileText,
  applyCueEdits,
  writeSubtitleFile,
  removePartialOutput,
  resolveTranslatedOutputPath,
  type CueEdit,
} from "../translator.js";
import { resolveConnectionPool } from "../connections.js";
import { estimateCost } from "../pricing.js";
import { assertMediaPathAllowed } from "../transcription-client.js";
import { isWatcherRunning } from "../watcher.js";
import { getAllSettings } from "../config.js";
import { logger } from "../logger.js";
import type { Job } from "../../shared/jobs.js";
import { queueFileTranslation, type FileTranslationTarget } from "../file-translation.js";
import {
  parsePositiveInteger,
  parsePositiveIntegerArray,
  sanitizeLanguageName,
} from "./validation.js";

// Enrich job rows with task data (since settings/tasks are in config, not SQL JOIN).
// Also surfaces token usage + an APPROXIMATE est_cost: jobs don't store which
// model ran, so we derive the model from the current connection pool primary
// (best-effort) and price the accumulated tokens. Unknown/local models → null.
function enrichJobs(jobs: JobRow[]): Job[] {
  const tasks = getTasks();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const { pool } = resolveConnectionPool(getAllSettings());
  const primaryModel = pool[0]?.model || "";
  return jobs.map((job) => {
    const task = taskMap.get(job.task_id);
    const inputTokens = Number(job.input_tokens) || 0;
    const outputTokens = Number(job.output_tokens) || 0;
    return {
      ...job,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      est_cost: estimateCost(primaryModel, inputTokens, outputTokens),
      target_lang: task?.target_lang || "",
      lang_code: task?.lang_code || "",
      source_lang: task?.source_lang || "",
      // Which machine (LLM connection) a translating job runs on; null otherwise.
      connection: job.status === "translating" ? getJobConnection(job.id) : null,
    };
  });
}

// A stopped or failed job leaves its in-flight .part beside the media; deleting
// the job must take that with it.
function removePartialsOfDeleted(before: JobRow[]) {
  const remaining = new Set(getJobs().map((job) => job.id));
  for (const job of before) {
    if (!remaining.has(job.id)) removePartialOutput(job.output_path);
  }
}

// A single-job reset/force/delete that changed no row was refused either because
// a worker is translating the job (409) or because there is no such job (404).
function rejectUnchanged(res: Response, id: number) {
  if (getJob(id)?.status === "translating")
    return res.status(409).json({ error: "Job is translating" });
  return res.status(404).json({ error: "Job not found" });
}

export function registerJobsRoutes(app: Express): void {
  // ======== Jobs ========
  app.get("/api/jobs", (_req, res) => {
    res.json({
      jobs: enrichJobs(getJobsForList()),
      queueRunning: isQueueRunning(),
      currentJobId: getCurrentJobId(),
    });
  });

  app.post("/api/jobs/:id/retry", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (resetJob(id) === 0) return rejectUnchanged(res, id);
    logger.info("queue", `Job #${id} reset to pending (retry)`, id);
    setTimeout(() => runQueueSafely(), 100);
    res.json({ ok: true });
  });

  // Translate one library subtitle into one language without changing the
  // global tasks; a language with no task gets a disabled one.
  app.post("/api/jobs/translate-file", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.srtPath !== "string" || !body.srtPath)
      return res.status(400).json({ error: "srtPath is required" });
    let target: FileTranslationTarget;
    if (body.taskId !== undefined) {
      const taskId = parsePositiveInteger(body.taskId);
      if (taskId === null) return res.status(400).json({ error: "taskId must be a positive integer" });
      target = { taskId };
    } else {
      const langCode = typeof body.langCode === "string" ? body.langCode.trim() : "";
      const targetLang = typeof body.targetLang === "string" ? sanitizeLanguageName(body.targetLang) : "";
      if (!langCode || !targetLang)
        return res.status(400).json({ error: "Either taskId, or both langCode and targetLang, are required" });
      target = { langCode, targetLang };
    }

    const result = queueFileTranslation(body.srtPath, target);
    if (result.kind === "rejected") return res.status(result.status).json({ error: result.error });
    setTimeout(() => runQueueSafely(), 100);
    res.json({ ok: true, jobId: result.jobId, taskId: result.taskId, created: result.kind === "queued" });
  });

  app.post("/api/jobs/retry-selected", (req, res) => {
    const rawIds = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(rawIds))
      return res.status(400).json({ error: "ids must be an array" });

    const ids = rawIds.filter(
      (v): v is number => typeof v === "number" && Number.isInteger(v),
    );
    const updated = resetJobs(ids);
    logger.info("queue", `Reset ${updated} selected error jobs to pending`);
    if (updated > 0) setTimeout(() => runQueueSafely(), 100);
    res.json({ ok: true, updated });
  });

  app.post("/api/jobs/:id/force", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (forceJob(id) === 0) return rejectUnchanged(res, id);
    logger.info("queue", `Job #${id} marked for force re-translate`, id);
    setTimeout(() => runQueueSafely(), 100);
    res.json({ ok: true });
  });

  // Cancels one translating job: its LLM calls are aborted and it ends as a
  // cancelled error, while the queue keeps running with the next pending job.
  app.post("/api/jobs/:id/cancel", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const job = getJob(id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "translating") return res.status(409).json({ error: "Job is not translating" });
    if (!requestJobCancel(id)) return res.status(409).json({ error: "Job is not translating" });
    res.json({ ok: true });
  });

  app.post("/api/jobs/force-selected", (req, res) => {
    const rawIds = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(rawIds))
      return res.status(400).json({ error: "ids must be an array" });

    const ids = rawIds.filter(
      (v): v is number => typeof v === "number" && Number.isInteger(v),
    );
    const updated = forceJobs(ids);
    logger.info(
      "queue",
      `Marked ${updated} selected jobs for force re-translate`,
    );
    if (updated > 0) setTimeout(() => runQueueSafely(), 100);
    res.json({ ok: true, updated });
  });

  app.post("/api/jobs/:id/pin", (req, res) => {
    const id = parseInt(req.params.id, 10);
    pinJob(id);
    logger.info("queue", `Job #${id} pinned to top of queue`, id);
    res.json({ ok: true });
  });

  app.post("/api/jobs/:id/unpin", (req, res) => {
    const id = parseInt(req.params.id, 10);
    unpinJob(id);
    logger.info("queue", `Job #${id} unpinned`, id);
    res.json({ ok: true });
  });

  app.post("/api/jobs/reorder", (req, res) => {
    const { jobIds } = req.body;
    const ids = parsePositiveIntegerArray(jobIds);
    if (!ids)
      return res
        .status(400)
        .json({ error: "jobIds must be an array of positive integers" });
    reorderJobs(ids);
    res.json({ ok: true });
  });

  app.post("/api/jobs/force-all", (_req, res) => {
    forceAllJobs();
    logger.info("queue", "All done/skipped jobs marked for force re-translate");
    setTimeout(() => runQueueSafely(), 100);
    res.json({ ok: true });
  });

  app.delete("/api/jobs/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const job = getJob(id);
    if (deleteJob(id) === 0) return rejectUnchanged(res, id);
    if (job) removePartialOutput(job.output_path);
    res.json({ ok: true });
  });

  app.post("/api/jobs/delete-selected", (req, res) => {
    const rawIds = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(rawIds))
      return res.status(400).json({ error: "ids must be an array" });

    const ids = rawIds.filter(
      (v): v is number => typeof v === "number" && Number.isInteger(v),
    );
    const before = getJobs();
    const deleted = deleteJobs(ids);
    removePartialsOfDeleted(before);
    logger.info("queue", `Deleted ${deleted} selected pending jobs from queue`);
    res.json({ ok: true, deleted });
  });

  app.post("/api/jobs/clear", (_req, res) => {
    const before = getJobs();
    const cleared = clearFinishedJobs();
    removePartialsOfDeleted(before);
    logger.info("queue", `Cleared ${cleared} finished jobs`);
    res.json({ ok: true, cleared });
  });

  // ======== Subtitle Preview (Feature 7) ========
  app.get("/api/jobs/:id/preview", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const job = getJob(id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Defense-in-depth: the paths come from the DB but still hit the filesystem,
    // so confirm they live under MEDIA_DIR before reading.
    try {
      assertMediaPathAllowed(job.srt_path, MEDIA_DIR);
      if (job.output_path) assertMediaPathAllowed(job.output_path, MEDIA_DIR);
    } catch (error: any) {
      return res
        .status(400)
        .json({ error: error?.message || "Invalid media path" });
    }

    try {
      const srcExt = path.extname(job.srt_path).slice(1).toLowerCase();
      const srcContent = readSubtitleFileText(job.srt_path);
      const srcParsed = parseSubtitle(srcContent, srcExt);
      let srcCues: any[];
      if (Array.isArray(srcParsed)) {
        srcCues = srcParsed.filter((l: any) => l.type === "cue");
      } else if ((srcParsed as any).events) {
        srcCues = (srcParsed as any).events;
      } else {
        srcCues = srcParsed as any;
      }

      let trgCues: any[] = [];
      const previewTarget = resolveTranslatedOutputPath(job.output_path);
      if (fs.existsSync(previewTarget)) {
        const trgExt = path.extname(job.output_path).slice(1).toLowerCase();
        const trgContent = readSubtitleFileText(previewTarget);
        const trgParsed = parseSubtitle(trgContent, trgExt);
        if (Array.isArray(trgParsed)) {
          trgCues = trgParsed.filter((l: any) => l.type === "cue");
        } else if ((trgParsed as any).events) {
          trgCues = (trgParsed as any).events;
        } else {
          trgCues = trgParsed as any;
        }
      }

      const lines = srcCues.map((cue: any, i: number) => ({
        index: i + 1,
        start: cue.data?.start,
        end: cue.data?.end,
        original: cue.data?.text || "",
        translated: trgCues[i]?.data?.text || "",
      }));

      const task = getTask(job.task_id);
      res.json({
        srtPath: job.srt_path,
        outputPath: job.output_path,
        targetLang: task?.target_lang || "",
        analysis: job.analysis_context || "",
        totalLines: lines.length,
        lines,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Apply manual translated-line edits to the OUTPUT file and re-export. Body:
  // { edits: Array<{ index: number; text: string }> } where `index` is the
  // 1-based cue index from the preview rows. Source file is never touched.
  app.put("/api/jobs/:id/cues", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const job = getJob(id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Defense-in-depth: confirm the DB-stored output path is under MEDIA_DIR
    // before we write to it.
    try {
      assertMediaPathAllowed(job.output_path, MEDIA_DIR);
    } catch (error: any) {
      return res
        .status(400)
        .json({ error: error?.message || "Invalid media path" });
    }

    const rawEdits = (req.body as { edits?: unknown })?.edits;
    if (!Array.isArray(rawEdits)) {
      return res.status(400).json({ error: "edits must be an array" });
    }

    // Coerce to well-typed edits; malformed entries are dropped here and any
    // out-of-range indices are skipped (and counted) inside applyCueEdits.
    const edits: CueEdit[] = rawEdits
      .filter(
        (e): e is CueEdit =>
          !!e &&
          typeof (e as any).index === "number" &&
          Number.isFinite((e as any).index) &&
          typeof (e as any).text === "string",
      )
      .map((e) => ({ index: Math.trunc(e.index), text: e.text }));

    if (!fs.existsSync(job.output_path)) {
      return res.status(404).json({ error: "Output file not found" });
    }

    try {
      const ext = path.extname(job.output_path).slice(1).toLowerCase();
      const content = readSubtitleFileText(job.output_path);
      const { output, updated } = applyCueEdits(content, ext, edits);
      writeSubtitleFile(job.output_path, output);
      res.json({ ok: true, updated });
    } catch (error: any) {
      res
        .status(500)
        .json({
          error: `Failed to save edits: ${error?.message || String(error)}`,
        });
    }
  });

  // Download the translated OUTPUT file as an attachment.
  app.get("/api/jobs/:id/download", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const job = getJob(id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    // Defense-in-depth: confirm the DB-stored output path is under MEDIA_DIR
    // before reading it off disk.
    try {
      assertMediaPathAllowed(job.output_path, MEDIA_DIR);
    } catch (error: any) {
      return res
        .status(400)
        .json({ error: error?.message || "Invalid media path" });
    }
    if (!fs.existsSync(job.output_path)) {
      return res.status(404).json({ error: "Output file not found" });
    }

    try {
      const basename = path.basename(job.output_path);
      const ext = path.extname(basename).slice(1).toLowerCase();
      const contentType =
        ext === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8";
      const content = readSubtitleFileText(job.output_path);
      res.setHeader("Content-Type", contentType);
      // Allow-list filename chars (CRLF/";" etc. could inject response headers).
      const safeName =
        basename.replace(/[^A-Za-z0-9._-]/g, "_") || "subtitle.srt";
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}"`,
      );
      res.send(content);
    } catch (error: any) {
      res
        .status(500)
        .json({
          error: `Failed to download: ${error?.message || String(error)}`,
        });
    }
  });

  // ======== Queue ========
  app.post("/api/queue/start", (req, res) => {
    if (isQueueRunning())
      return res.json({ ok: true, message: "Already running" });
    const rawIds = (req.body as { ids?: unknown })?.ids;
    const ids =
      rawIds === undefined ? undefined : parsePositiveIntegerArray(rawIds);
    if (rawIds !== undefined && !ids) {
      return res
        .status(400)
        .json({ error: "ids must be an array of positive integers" });
    }
    runQueueSafely(ids && ids.length > 0 ? ids : undefined);
    res.json({
      ok: true,
      message: "Queue started",
      count: ids?.length ?? null,
    });
  });

  app.post("/api/queue/stop", (_req, res) => {
    requestStop();
    res.json({ ok: true, message: "Stop requested" });
  });

  app.get("/api/queue/status", (_req, res) => {
    const currentId = getCurrentJobId();
    const currentJob = currentId ? getJob(currentId) : null;
    res.json({
      running: isQueueRunning(),
      currentJobId: currentId,
      currentJob: currentJob ? enrichJobs([currentJob])[0] : null,
      // Parallel mode runs several jobs at once, each pinned to a connection
      // ("machine"); the dashboard shows the pairing.
      activeConnections: getActiveJobConnections(),
      pendingCount: countPendingJobs(),
      watcherRunning: isWatcherRunning(),
    });
  });
}
