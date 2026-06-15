import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTO_SOURCE_LANGUAGE,
  getAllSettings,
  setSetting,
  getSetting,
  getTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
} from "./config.js";
import {
  getJobs,
  getJob,
  resetJob,
  resetJobs,
  forceJob,
  forceJobs,
  forceAllJobs,
  deleteJob,
  deleteJobs,
  clearJobs,
  getLogs,
  clearLogs,
  pinJob,
  unpinJob,
  reorderJobs,
} from "./db.js";
import { scanFolder, listSubfolders, listFolderTree, MEDIA_DIR } from "./scanner.js";
import {
  processQueue,
  isQueueRunning,
  getCurrentJobId,
  requestStop,
  startAutoScan,
  stopAutoScan,
} from "./queue.js";
import { testConnection, parseSubtitle, convertSubtitle } from "./translator.js";
import { resolveConnectionPool } from "./connections.js";
import type { CloudProvider } from "./translator.js";
import {
  applyPreflightPolicy,
  buildTranscriptionRequest,
  fetchTranscriptionHealth,
  localTranscriptionOutputPath,
  preflightTranscription,
  transcribePostActionValues,
  transcribeWithBackend,
  type TranscribePostAction,
  type TranscriptionOutputFormat,
} from "./transcription-client.js";
import { summarizeTranscriptionError, transcriptionHistory } from "./transcription-history.js";
import { logger } from "./logger.js";
import { addSSEClient, broadcast } from "./sse.js";
import { startWatcher, stopWatcher, isWatcherRunning, restartWatcher } from "./watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const staticDir = path.join(__dirname, "../../dist/client");
app.use(express.static(staticDir));

// ======== SSE (Feature 6) ========
app.get("/api/events", (req, res) => {
  addSSEClient(res);
});

// ======== Settings ========
app.get("/api/settings", (_req, res) => {
  res.json({
    ...getAllSettings(),
    _media_dir: MEDIA_DIR,
    _watcher_running: isWatcherRunning(),
  });
});

app.post("/api/settings", (req, res) => {
  const settings = req.body;
  const changedKeys: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith("_")) continue;
    setSetting(key, String(value));
    changedKeys.push(key);
  }
  logger.info("system", `Settings updated: ${changedKeys.join(", ")}`);

  const interval = parseInt(getSetting("auto_scan_interval") || "0", 10);
  if (interval > 0) startAutoScan(interval, scanFolder);
  else stopAutoScan();

  if (changedKeys.includes("watch_enabled")) {
    restartWatcher();
  }
  res.json({ ok: true });
});

// ======== Translation Tasks ========
app.get("/api/tasks", (_req, res) => res.json(getTasks()));

app.post("/api/tasks", (req, res) => {
  const { source_lang, target_lang, output_pattern, lang_code } = req.body;
  if (!target_lang || !lang_code) return res.status(400).json({ error: "target_lang and lang_code are required" });
  const result = createTask({
    source_lang: source_lang || AUTO_SOURCE_LANGUAGE,
    target_lang,
    output_pattern: output_pattern || "{{name}}.{{lang_code}}.srt",
    lang_code,
  });
  logger.info("system", `Created translation task: ${target_lang} (${lang_code})`);
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});

app.put("/api/tasks/:id", (req, res) => {
  updateTask(parseInt(req.params.id, 10), req.body);
  res.json({ ok: true });
});

app.delete("/api/tasks/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  deleteTask(id);
  logger.info("system", `Deleted translation task #${id}`);
  res.json({ ok: true });
});

// ======== Subtitle Format Converter ========
// Pure client-driven format conversion (no translation, no DB). The browser
// uploads file contents; we re-stringify each into the target format and return
// them inline. Per-file failures are collected in `errors` so one bad file
// never fails the whole batch.
const CONVERT_TARGET_FORMATS = ["srt", "vtt", "ass", "ssa"] as const;
const MAX_CONVERT_FILES = 50;
const MAX_CONVERT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file

app.post("/api/convert", (req, res) => {
  const body = req.body ?? {};
  const targetFormat = String(body.targetFormat || "").toLowerCase();
  const files = Array.isArray(body.files) ? body.files : null;

  if (!CONVERT_TARGET_FORMATS.includes(targetFormat as (typeof CONVERT_TARGET_FORMATS)[number])) {
    return res.status(400).json({ error: `Unsupported target format. Use one of: ${CONVERT_TARGET_FORMATS.join(", ")}` });
  }
  if (!files) {
    return res.status(400).json({ error: "files must be an array of { name, content }" });
  }
  if (files.length === 0) {
    return res.status(400).json({ error: "No files provided" });
  }
  if (files.length > MAX_CONVERT_FILES) {
    return res.status(400).json({ error: `Too many files (max ${MAX_CONVERT_FILES})` });
  }
  for (const file of files) {
    const content = typeof file?.content === "string" ? file.content : "";
    if (Buffer.byteLength(content, "utf8") > MAX_CONVERT_FILE_BYTES) {
      return res.status(400).json({ error: `File too large: ${String(file?.name || "unknown")} (max 10MB per file)` });
    }
  }

  const outputs: { name: string; content: string }[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const file of files) {
    const name = String(file?.name || "subtitle");
    const content = typeof file?.content === "string" ? file.content : "";
    const dotIndex = name.lastIndexOf(".");
    const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
    const sourceExt = dotIndex >= 0 ? name.slice(dotIndex + 1).toLowerCase() : "";
    try {
      const converted = convertSubtitle(content, sourceExt, targetFormat);
      outputs.push({ name: `${baseName}.${targetFormat}`, content: converted });
    } catch (error) {
      errors.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  logger.info("system", `Converted ${outputs.length}/${files.length} subtitle file(s) → ${targetFormat}`);
  res.json({ files: outputs, errors });
});

// ======== Subfolders ========
app.get("/api/subfolders", (_req, res) => {
  res.json({ subfolders: listSubfolders() });
});

app.get("/api/folders/tree", (_req, res) => {
  res.json({ root: listFolderTree() });
});

// ======== Scanner ========
app.post("/api/scan", async (_req, res) => {
  try {
    let result = scanFolder(true);
    const settings = getAllSettings();
    const behavior = settings.transcription_missing_subtitle_behavior || "ask";
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (settings.transcription_enabled === "1" && backendUrl && behavior !== "ask") {
      const postAction: TranscribePostAction = behavior === "auto_transcribe_and_translate" ? "transcribe_and_translate" : "transcribe_only";
      const missingVideos = result.files
        .filter((file) => file.videoPath && file.subtitles.length === 0)
        .map((file) => file.videoPath as string);
      const maxConcurrent = Math.max(1, Math.min(4, parseInt(settings.transcription_max_concurrent || "1", 10) || 1));
      for (let i = 0; i < missingVideos.length; i += maxConcurrent) {
        const batch = missingVideos.slice(i, i + maxConcurrent);
        await Promise.all(batch.map(async (videoPath) => {
          try {
            const request = buildTranscriptionRequest({ videoPath, mediaDir: MEDIA_DIR, settings, postAction });
            const checkedRequest = await applyPreflightPolicy(backendUrl, request, settings);
            const transcribed = await transcribeWithBackend(backendUrl, checkedRequest);
            logger.info("system", `Auto-transcribed ${path.basename(videoPath)} → ${transcribed.subtitle_path || "subtitle output"}`);
          } catch (error: any) {
            const message = error?.message || String(error);
            if (settings.transcription_low_ram_behavior === "skip" && message.startsWith("Transcription skipped:")) {
              logger.info("system", `Skipped auto-transcription for ${path.basename(videoPath)}: ${message}`);
              return;
            }
            throw error;
          }
        }));
      }
      if (missingVideos.length > 0) {
        result = scanFolder(postAction === "transcribe_and_translate");
      }
    }
    if (result.newJobs > 0 && getSetting("auto_translate") === "1") {
      setTimeout(() => processQueue(), 100);
    }
    broadcast("scan:complete", { newJobs: result.newJobs, total: result.totalSubtitles });
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/scan/preview", (_req, res) => {
  try {
    res.json(scanFolder(false));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// ======== Jobs ========

// Enrich job rows with task data (since settings/tasks are in config, not SQL JOIN)
function enrichJobs(jobs: any[]): any[] {
  const tasks = getTasks();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  return jobs.map((job) => {
    const task = taskMap.get(job.task_id);
    return {
      ...job,
      target_lang: task?.target_lang || "",
      lang_code: task?.lang_code || "",
      source_lang: task?.source_lang || "",
    };
  });
}

app.get("/api/jobs", (_req, res) => {
  res.json({
    jobs: enrichJobs(getJobs() as any[]),
    queueRunning: isQueueRunning(),
    currentJobId: getCurrentJobId(),
  });
});

app.post("/api/jobs/:id/retry", (req, res) => {
  const id = parseInt(req.params.id, 10);
  resetJob(id);
  logger.info("queue", `Job #${id} reset to pending (retry)`, id);
  setTimeout(() => processQueue(), 100);
  res.json({ ok: true });
});

app.post("/api/jobs/retry-selected", (req, res) => {
  const rawIds = (req.body as { ids?: unknown })?.ids;
  if (!Array.isArray(rawIds)) return res.status(400).json({ error: "ids must be an array" });

  const ids = rawIds.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  const updated = resetJobs(ids);
  logger.info("queue", `Reset ${updated} selected error jobs to pending`);
  if (updated > 0) setTimeout(() => processQueue(), 100);
  res.json({ ok: true, updated });
});

app.post("/api/jobs/:id/force", (req, res) => {
  const id = parseInt(req.params.id, 10);
  forceJob(id);
  logger.info("queue", `Job #${id} marked for force re-translate`, id);
  setTimeout(() => processQueue(), 100);
  res.json({ ok: true });
});

app.post("/api/jobs/force-selected", (req, res) => {
  const rawIds = (req.body as { ids?: unknown })?.ids;
  if (!Array.isArray(rawIds)) return res.status(400).json({ error: "ids must be an array" });

  const ids = rawIds.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  const updated = forceJobs(ids);
  logger.info("queue", `Marked ${updated} selected jobs for force re-translate`);
  if (updated > 0) setTimeout(() => processQueue(), 100);
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
  if (!Array.isArray(jobIds)) return res.status(400).json({ error: "jobIds must be an array" });
  reorderJobs(jobIds);
  res.json({ ok: true });
});

app.post("/api/jobs/force-all", (_req, res) => {
  forceAllJobs();
  logger.info("queue", "All done/skipped jobs marked for force re-translate");
  setTimeout(() => processQueue(), 100);
  res.json({ ok: true });
});

app.delete("/api/jobs/:id", (req, res) => {
  deleteJob(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.post("/api/jobs/delete-selected", (req, res) => {
  const rawIds = (req.body as { ids?: unknown })?.ids;
  if (!Array.isArray(rawIds)) return res.status(400).json({ error: "ids must be an array" });

  const ids = rawIds.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  const deleted = deleteJobs(ids);
  logger.info("queue", `Deleted ${deleted} selected pending jobs from queue`);
  res.json({ ok: true, deleted });
});

app.post("/api/jobs/clear", (_req, res) => {
  clearJobs();
  logger.info("queue", "All jobs cleared");
  res.json({ ok: true });
});

// ======== Subtitle Preview (Feature 7) ========
app.get("/api/jobs/:id/preview", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const job = getJob(id) as any;
  if (!job) return res.status(404).json({ error: "Job not found" });

  try {
    const srcExt = path.extname(job.srt_path).slice(1).toLowerCase();
    const srcContent = fs.readFileSync(job.srt_path, "utf8");
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
    if (fs.existsSync(job.output_path)) {
      const trgExt = path.extname(job.output_path).slice(1).toLowerCase();
      const trgContent = fs.readFileSync(job.output_path, "utf8");
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

// ======== Queue ========
app.post("/api/queue/start", (req, res) => {
  if (isQueueRunning()) return res.json({ ok: true, message: "Already running" });
  const rawIds = (req.body as { ids?: unknown })?.ids;
  const ids = Array.isArray(rawIds)
    ? rawIds.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : undefined;
  processQueue(ids && ids.length > 0 ? ids : undefined);
  res.json({ ok: true, message: "Queue started", count: ids?.length ?? null });
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
    pendingCount: (getJobs("pending") as any[]).length,
    watcherRunning: isWatcherRunning(),
  });
});

// ======== Watcher (Feature 4) ========
app.post("/api/watcher/start", (_req, res) => {
  setSetting("watch_enabled", "1");
  startWatcher();
  res.json({ ok: true, running: true });
});

app.post("/api/watcher/stop", (_req, res) => {
  setSetting("watch_enabled", "0");
  stopWatcher();
  res.json({ ok: true, running: false });
});

app.get("/api/watcher/status", (_req, res) => {
  res.json({ running: isWatcherRunning() });
});

// ======== Logs ========
app.get("/api/logs", (req, res) => {
  const { level, category, job_id, limit, offset } = req.query;
  const parsedJobId = typeof job_id === "string" ? parseInt(job_id, 10) : NaN;
  res.json(
    getLogs({
      level: level as string | undefined,
      category: category as string | undefined,
      jobId: Number.isFinite(parsedJobId) ? parsedJobId : undefined,
      limit: limit ? parseInt(limit as string, 10) : 100,
      offset: offset ? parseInt(offset as string, 10) : 0,
    })
  );
});

app.delete("/api/logs", (_req, res) => {
  clearLogs();
  logger.info("system", "Logs cleared");
  res.json({ ok: true });
});

app.get("/api/llm-health", async (_req, res) => {
  const settings = getAllSettings();
  const endpoint = (settings.llm_endpoint || "").replace(/\/+$/, "");
  const model = settings.model || "";
  const apiKey = settings.api_key || "";

  if (!endpoint) {
    return res.json({
      ok: false,
      endpointReachable: false,
      modelConfigured: Boolean(model),
      modelAvailable: false,
      reason: "endpoint-missing",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${endpoint}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return res.json({
        ok: false,
        endpointReachable: false,
        modelConfigured: Boolean(model),
        modelAvailable: false,
        status: resp.status,
        reason: `http-${resp.status}`,
      });
    }

    const data = await resp.json() as any;
    const models: string[] = (data?.data || data?.models || [])
      .map((m: any) => m.id || m.name || m)
      .filter((m: any) => typeof m === "string");

    const modelConfigured = Boolean(model);
    const modelAvailable = modelConfigured ? models.includes(model) : false;

    return res.json({
      ok: modelConfigured && modelAvailable,
      endpointReachable: true,
      modelConfigured,
      modelAvailable,
      model,
      modelCount: models.length,
      reason: modelConfigured ? (modelAvailable ? "ok" : "model-missing") : "model-not-configured",
    });
  } catch (error: any) {
    clearTimeout(timeout);
    return res.json({
      ok: false,
      endpointReachable: false,
      modelConfigured: Boolean(model),
      modelAvailable: false,
      reason: error?.name === "AbortError" ? "timeout" : "network-error",
      message: error?.message || "unknown",
    });
  }
});

// ======== Speech-to-text / transcription ========
function getTranscriptionBackendUrl(settings = getAllSettings()): string {
  return (settings.transcription_backend_url || process.env.WHISPER_BACKEND_URL || "").replace(/\/+$/, "");
}

async function runTranscriptionAttempt(opts: {
  videoPath: string;
  postAction: TranscribePostAction;
  outputFormat?: TranscriptionOutputFormat;
  settings?: Record<string, string>;
}) {
  const settings = opts.settings || getAllSettings();
  const backendUrl = getTranscriptionBackendUrl(settings);
  if (settings.transcription_enabled !== "1") throw new Error("Speech-to-text is disabled in settings");
  if (!backendUrl) throw new Error("Transcription backend URL is not configured");

  const request = buildTranscriptionRequest({
    videoPath: opts.videoPath,
    mediaDir: MEDIA_DIR,
    settings,
    outputFormat: opts.outputFormat,
    postAction: opts.postAction,
  });
  const outputPath = localTranscriptionOutputPath(opts.videoPath, request.language, request.output_format);
  const attempt = transcriptionHistory.startAttempt({
    // Store the local SubSmelt media path so history retries re-run through
    // MEDIA_DIR validation and optional backend path mapping correctly.
    inputPath: opts.videoPath,
    outputPath,
    model: request.model,
    language: request.language,
    outputFormat: request.output_format,
    postAction: request.post_action,
    subtitleQuality: request.subtitle_quality,
    advancedOptions: request.advanced_options,
  });

  try {
    const startedAtMs = Date.parse(attempt.startedAt);
    const checkedRequest = await applyPreflightPolicy(backendUrl, request, settings);
    const result = await transcribeWithBackend(backendUrl, checkedRequest);
    const finishedAt = new Date().toISOString();
    const durationSeconds = typeof result.duration_seconds === "number"
      ? result.duration_seconds
      : Number.isFinite(startedAtMs)
        ? Math.max(0, (Date.now() - startedAtMs) / 1000)
        : null;
    transcriptionHistory.finishAttempt(attempt.id, {
      status: "succeeded",
      finishedAt,
      durationSeconds,
    });
    return { attemptId: attempt.id, result };
  } catch (error: unknown) {
    const summary = summarizeTranscriptionError(error);
    transcriptionHistory.finishAttempt(attempt.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      errorSummary: summary,
    });
    throw new Error(summary);
  }
}

app.get("/api/transcribe/health", async (_req, res) => {
  const settings = getAllSettings();
  const backendUrl = getTranscriptionBackendUrl(settings);
  const selectedModel = typeof settings.transcription_model === "string" && settings.transcription_model.trim()
    ? settings.transcription_model.trim()
    : "small";
  if (!backendUrl) {
    return res.json({ ok: false, endpointReachable: false, reason: "endpoint-missing" });
  }
  try {
    const health = await fetchTranscriptionHealth(backendUrl, selectedModel);
    return res.json({ ok: true, endpointReachable: true, backendUrl, health });
  } catch (error: any) {
    return res.json({ ok: false, endpointReachable: false, backendUrl, reason: "network-error", message: error?.message || "unknown" });
  }
});

app.post("/api/transcribe/preflight", async (req, res) => {
  const settings = getAllSettings();
  const backendUrl = getTranscriptionBackendUrl(settings);
  if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
  const videoPath = typeof req.body?.videoPath === "string" ? req.body.videoPath : "";
  if (!videoPath) return res.status(400).json({ error: "videoPath is required" });
  try {
    const request = buildTranscriptionRequest({
      videoPath,
      mediaDir: MEDIA_DIR,
      settings,
      outputFormat: req.body?.outputFormat as TranscriptionOutputFormat | undefined,
      postAction: req.body?.postAction as TranscribePostAction | undefined,
    });
    const result = await preflightTranscription(backendUrl, request);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || "Transcription preflight failed" });
  }
});

app.get("/api/transcribe/history", (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
  res.json({ attempts: transcriptionHistory.listRecent(Number.isFinite(limit) ? limit : 20) });
});

app.post("/api/transcribe/history/:id/retry", async (req, res) => {
  const attempt = transcriptionHistory.get(req.params.id);
  if (!attempt) return res.status(404).json({ error: "Transcription attempt not found" });
  try {
    const { result, attemptId } = await runTranscriptionAttempt({
      videoPath: attempt.inputPath,
      postAction: attempt.postAction,
      outputFormat: attempt.outputFormat,
    });
    logger.info("system", `Retried transcription ${path.basename(attempt.inputPath)} → ${result.subtitle_path || "subtitle output"}`);

    let scanResult: ReturnType<typeof scanFolder> | null = null;
    if (attempt.postAction === "transcribe_and_translate") {
      scanResult = scanFolder(true);
      if (scanResult.newJobs > 0) setTimeout(() => processQueue(), 100);
    }

    const { ok: _backendOk, ...transcriptionResult } = result as { ok?: boolean } & Record<string, unknown>;
    return res.json({ ok: true, attemptId, ...transcriptionResult, postAction: attempt.postAction, scanResult });
  } catch (error: any) {
    logger.error("system", `Transcription retry failed: ${error?.message || error}`);
    return res.status(400).json({ error: error?.message || "Transcription retry failed" });
  }
});

app.post("/api/transcribe", async (req, res) => {
  const settings = getAllSettings();
  const videoPath = typeof req.body?.videoPath === "string" ? req.body.videoPath : "";
  if (!videoPath) return res.status(400).json({ error: "videoPath is required" });
  const requestedPostAction = req.body?.postAction as TranscribePostAction | undefined;
  const postAction = requestedPostAction && transcribePostActionValues.includes(requestedPostAction) ? requestedPostAction : "transcribe_only";

  try {
    const { result, attemptId } = await runTranscriptionAttempt({
      videoPath,
      postAction,
      outputFormat: req.body?.outputFormat as TranscriptionOutputFormat | undefined,
      settings,
    });
    logger.info("system", `Transcribed ${path.basename(videoPath)} → ${result.subtitle_path || "subtitle output"}`);

    let scanResult: ReturnType<typeof scanFolder> | null = null;
    if (postAction === "transcribe_and_translate") {
      scanResult = scanFolder(true);
      if (scanResult.newJobs > 0) setTimeout(() => processQueue(), 100);
    }

    const { ok: _backendOk, ...transcriptionResult } = result as { ok?: boolean } & Record<string, unknown>;
    return res.json({ ok: true, attemptId, stage: "complete", ...transcriptionResult, postAction, scanResult });
  } catch (error: any) {
    logger.error("system", `Transcription failed: ${error?.message || error}`);
    return res.status(400).json({ error: error?.message || "Transcription failed" });
  }
});

// ======== List Models ========
app.get("/api/models", async (req, res) => {
  const settings = getAllSettings();
  const provider = (req.query.provider as string) || "local";
  // Optional overrides so a not-yet-saved connection card can fetch its models.
  const keyOverride = (req.query.key as string) || "";
  const endpointOverride = (req.query.endpoint as string) || "";

  try {
    // ── Cloud providers ────────────────────────────────────────────────────
    if (provider === "openai") {
      const apiKey = keyOverride || settings.cloud_api_key_openai || "";
      if (!apiKey) return res.status(400).json({ error: "No OpenAI API key configured" });
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) return res.status(resp.status).json({ error: `OpenAI returned ${resp.status}` });
      const data = await resp.json() as any;
      const models: string[] = (data?.data || [])
        .map((m: any) => m.id)
        .filter((id: string) => typeof id === "string" && (
          id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")
        ))
        .sort();
      return res.json({ models, provider });
    }

    if (provider === "anthropic") {
      const apiKey = keyOverride || settings.cloud_api_key_anthropic || "";
      if (!apiKey) return res.status(400).json({ error: "No Anthropic API key configured" });
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (!resp.ok) return res.status(resp.status).json({ error: `Anthropic returned ${resp.status}` });
      const data = await resp.json() as any;
      const models: string[] = (data?.data || [])
        .map((m: any) => m.id)
        .filter((id: string) => typeof id === "string")
        .sort();
      return res.json({ models, provider });
    }

    if (provider === "gemini") {
      const apiKey = keyOverride || settings.cloud_api_key_gemini || "";
      if (!apiKey) return res.status(400).json({ error: "No Gemini API key configured" });
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`
      );
      if (!resp.ok) return res.status(resp.status).json({ error: `Gemini returned ${resp.status}` });
      const data = await resp.json() as any;
      const models: string[] = (data?.models || [])
        .map((m: any) => (m.name || "").replace(/^models\//, ""))
        .filter((id: string) => typeof id === "string" && id.startsWith("gemini"))
        .sort();
      return res.json({ models, provider });
    }

    // ── Local / OpenAI-compatible endpoint ────────────────────────────────
    const endpoint = (endpointOverride || settings.llm_endpoint || "http://localhost:8000/v1").replace(/\/+$/, "");
    const apiKey = keyOverride || settings.api_key || "";
    const url = endpoint + "/models";
    const resp = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!resp.ok) return res.status(resp.status).json({ error: `LLM returned ${resp.status}` });
    const data = await resp.json() as any;
    const models: string[] = (data?.data || data?.models || [])
      .map((m: any) => m.id || m.name || m)
      .filter((m: any) => typeof m === "string");
    res.json({ models, provider: "local" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ======== Test Connection ========
app.post("/api/test-connection", async (req, res) => {
  const settings = getAllSettings();
  const body = (req.body || {}) as { provider?: string; apiKey?: string; model?: string; endpoint?: string };

  // If the client passes explicit connection fields (e.g. a not-yet-saved
  // connection card), test those. Otherwise test the active connection.
  let conn: { apiKey: string; apiHost: string; model: string; provider?: CloudProvider };
  if (body.provider !== undefined || body.apiKey !== undefined || body.model !== undefined) {
    conn = {
      apiKey: body.apiKey || "",
      apiHost: body.endpoint || settings.llm_endpoint || "http://localhost:8000/v1",
      model: body.model || "",
      provider: body.provider && body.provider !== "local" ? (body.provider as CloudProvider) : undefined,
    };
  } else {
    const { pool } = resolveConnectionPool(settings);
    const primary = pool[0];
    conn = primary
      ? { apiKey: primary.apiKey, apiHost: primary.apiHost, model: primary.model, provider: primary.provider }
      : { apiKey: settings.api_key || "", apiHost: settings.llm_endpoint || "http://localhost:8000/v1", model: settings.model || "" };
  }

  const result = await testConnection(conn);
  if (result.ok) logger.info("system", `Connection test passed: ${result.message}`);
  else logger.error("system", `Connection test failed: ${result.message}`);
  res.json(result);
});

// ======== Health ========
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, queueRunning: isQueueRunning(), watcherRunning: isWatcherRunning() });
});

// ======== SPA Fallback ========
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

// ======== Start ========
app.listen(PORT, "0.0.0.0", () => {
  const envOverrides: Record<string, string | undefined> = {
    llm_endpoint: process.env.LLM_ENDPOINT,
    api_key: process.env.API_KEY,
    model: process.env.MODEL,
    transcription_backend_url: process.env.WHISPER_BACKEND_URL,
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value !== undefined && value !== "") setSetting(key, value);
  }
  logger.info("system", `SubSmelt started on port ${PORT}`);
  logger.info("system", `Timezone: ${process.env.TZ || "UTC"}`);
  logger.info("system", `Media directory: ${MEDIA_DIR}`);
  console.log(`\n  SubSmelt`);
  console.log(`  → http://localhost:${PORT}\n`);

  const interval = parseInt(getSetting("auto_scan_interval") || "0", 10);
  if (interval > 0) startAutoScan(interval, scanFolder);
  if (getSetting("watch_enabled") === "1") startWatcher();
});
