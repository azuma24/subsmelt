import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAllSettings,
  setSetting,
  getSetting,
} from "./config.js";
import { scanFolder, listSubfolders, listFolderTree, MEDIA_DIR } from "./scanner.js";
import {
  processQueue,
  isQueueRunning,
  requestStop,
  startAutoScan,
} from "./queue.js";
import { transcriptionHistory } from "./transcription-history.js";
import { logger } from "./logger.js";
import { getLogs, clearLogs } from "./db.js";
import { addSSEClient, broadcast } from "./sse.js";
import { notifyTest } from "./notify.js";
import { startWatcher, stopWatcher, isWatcherRunning } from "./watcher.js";
import type { TranscribePostAction } from "./transcription-client.js";
import { registerSettingsTasksRoutes } from "./routes/settings-tasks.js";
import { registerJobsRoutes } from "./routes/jobs.js";
import { registerModelsRoutes } from "./routes/models.js";
import {
  registerTranscriptionRoutes,
  getTranscriptionBackendUrl,
  runTranscriptionAttempt,
} from "./routes/transcription.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// The web UI is served same-origin from this server, so cross-origin browser
// requests are never needed. Disabling the allow-origin header prevents other
// sites from scripting this self-hosted API via the user's browser.
app.use(cors({ origin: false }));
app.use(express.json({ limit: "25mb" }));

const staticDir = path.join(__dirname, "../../dist/client");
app.use(express.static(staticDir));

// ======== SSE (Feature 6) ========
app.get("/api/events", (req, res) => {
  addSSEClient(res);
});

registerSettingsTasksRoutes(app);

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
      // Per-file isolation: a single failure must NOT abort the whole scan
      // batch. Each file is transcribed through runTranscriptionAttempt (which
      // records a history entry and acquires the shared concurrency slot), and
      // any hard failure is caught + logged here so remaining files continue.
      await Promise.all(missingVideos.map(async (videoPath) => {
        try {
          const { result: transcribed } = await runTranscriptionAttempt({ videoPath, postAction, settings });
          logger.info("system", `Auto-transcribed ${path.basename(videoPath)} → ${transcribed.subtitle_path || "subtitle output"}`);
        } catch (error: any) {
          const message = error?.message || String(error);
          if (settings.transcription_low_ram_behavior === "skip" && message.startsWith("Transcription skipped:")) {
            logger.info("system", `Skipped auto-transcription for ${path.basename(videoPath)}: ${message}`);
            return;
          }
          logger.error("system", `Auto-transcription failed for ${path.basename(videoPath)}: ${message}`);
        }
      }));
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

registerJobsRoutes(app);

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

registerModelsRoutes(app);

registerTranscriptionRoutes(app);

// ======== Notification test ========
// Sends a sample webhook using the current settings (format + URL), bypassing
// the notify_events filter so the UI can verify connectivity. Never affects
// translation/queue — this is an isolated, on-demand call.
app.post("/api/notify/test", async (_req, res) => {
  const result = await notifyTest();
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
    // Lets the compose shared-FS setup pin transport=shared (the backend reads
    // /media in place); otherwise auto picks upload for a non-loopback host.
    transcription_transport: process.env.WHISPER_TRANSPORT,
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value !== undefined && value !== "") setSetting(key, value);
  }
  // Reconcile any transcription attempts left "running" by a previous process
  // (e.g. crash/restart mid-transcription) so they no longer hang in history.
  const reconciled = transcriptionHistory.reconcileRunning();
  if (reconciled > 0) {
    logger.info("system", `Reconciled ${reconciled} interrupted transcription attempt(s) as failed`);
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
