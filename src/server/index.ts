import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
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
import { testConnection, parseSubtitle } from "./translator.js";
import { logger } from "./logger.js";
import { addSSEClient, broadcast } from "./sse.js";
import { startWatcher, stopWatcher, isWatcherRunning, restartWatcher } from "./watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(cors());
app.use(express.json());

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
  const { source_lang, target_lang, output_pattern, output_format, lang_code } = req.body;
  if (!target_lang || !lang_code) return res.status(400).json({ error: "target_lang and lang_code are required" });
  const result = createTask({
    source_lang: source_lang || "English",
    target_lang,
    output_pattern: output_pattern || "{{name}}.{{lang_code}}.srt",
    output_format: output_format || "srt",
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

// ======== Subfolders ========
app.get("/api/subfolders", (_req, res) => {
  res.json({ subfolders: listSubfolders() });
});

app.get("/api/folders/tree", (_req, res) => {
  res.json({ root: listFolderTree() });
});

// ======== Scanner ========
app.post("/api/scan", (_req, res) => {
  try {
    const result = scanFolder(true);
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
  const { level, category, limit, offset } = req.query;
  res.json(
    getLogs({
      level: level as string | undefined,
      category: category as string | undefined,
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

// ======== List Models ========
app.get("/api/models", async (_req, res) => {
  const settings = getAllSettings();
  const endpoint = (settings.llm_endpoint || "http://localhost:8000/v1").replace(/\/+$/, "");
  const apiKey = settings.api_key || "";
  const apiType = settings.api_type || "openai";
  try {
    // LM Studio uses /api/v1/models, OpenAI-compatible uses /v1/models
    // We just append /models to whatever endpoint is configured
    const url = endpoint + "/models";
    const resp = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!resp.ok) return res.status(resp.status).json({ error: `LLM returned ${resp.status}` });
    const data = await resp.json() as any;
    // LM Studio returns { data: [...] }, OpenAI-compat same, Ollama may differ
    const models: string[] = (data?.data || data?.models || [])
      .map((m: any) => m.id || m.name || m)
      .filter((m: any) => typeof m === "string");
    res.json({ models, apiType });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ======== Test Connection ========
app.post("/api/test-connection", async (_req, res) => {
  const settings = getAllSettings();
  const result = await testConnection({
    apiKey: settings.api_key || "",
    apiHost: settings.llm_endpoint || "http://localhost:8000/v1",
    model: settings.model || "",
  });
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
