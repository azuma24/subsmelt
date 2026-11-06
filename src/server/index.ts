import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSetting } from "./config.js";
import { listFolderTree, MEDIA_DIR } from "./scanner.js";
import { isQueueRunning, resumeQueueOnBoot } from "./queue.js";
import { transcriptionHistory } from "./transcription-history.js";
import { transcriptionWork } from "./transcription/work.js";
import { previewLibraryScan, scanAndEnqueue } from "./library-scan.js";
import { logger } from "./logger.js";
import { crossSiteGuard, createIngressGuard } from "./cross-site-guard.js";
import db, { getLogs, clearLogs } from "./db.js";
import { addSSEClient } from "./sse.js";
import { notifyTest } from "./notify.js";
import { getWatcherStatus, syncWatcher } from "./watcher.js";
import { parseLogsQuery } from "./routes/validation.js";

import { registerSettingsTasksRoutes } from "./routes/settings-tasks.js";
import { registerConvertBatchRoutes } from "./routes/convert-batches.js";
import { registerJobsRoutes } from "./routes/jobs.js";
import { registerWatcherRoutes } from "./routes/watcher.js";
import { registerEmbeddedSubtitleRoutes } from "./routes/embedded-subtitles.js";
import { registerCorrectionsRoutes } from "./routes/corrections.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerLlmStatusRoutes } from "./routes/llm-status.js";
import { registerYoutubeRoutes } from "./routes/youtube.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { YoutubeStore } from "./youtube/store.js";
import { YoutubeWorker } from "./youtube/worker.js";
import { registerTranscriptionRoutes } from "./routes/transcription.js";
import { errorMessage } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Backstop for promises no caller owns (a timer callback, a SSE write racing a
// settle). Each producer catches its own rejections; this keeps one that
// slipped through from killing the process, and makes it visible.
process.on("unhandledRejection", (reason) => {
  logger.error("system", `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const PORT = parseInt(process.env.PORT || "3000", 10);
// Every interface by default so a container's published port works; set HOST
// to 127.0.0.1 behind a reverse proxy that should be the only way in.
const HOST = process.env.HOST || "0.0.0.0";

// The web UI is served same-origin from this server, so cross-origin browser
// requests are never needed. Disabling the allow-origin header prevents other
// sites from scripting this self-hosted API via the user's browser.
// CORS hides responses, but a foreign page can still fire a simple POST; this
// refuses those before any route acts on them.
app.use(createIngressGuard(process.env));
app.use(crossSiteGuard);
app.use(express.json({ limit: "25mb" }));
// Express 5 leaves req.body undefined when no parser matched the request (a
// bodyless POST, a non-JSON content type); the routes destructure it, so keep
// Express 4's empty object.
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Baseline browser hardening for a LAN-facing app: no MIME sniffing, no
// framing by other sites, no referrer leaking an internal address.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

const staticDir = path.join(__dirname, "../../dist/client");
// Vite names every built asset by content hash, so those can be cached for a
// year and never revalidated; index.html and the favicon keep their names and
// must be checked on every load so a new release shows up.
app.use("/assets", express.static(path.join(staticDir, "assets"), { immutable: true, maxAge: "1y", index: false }));
app.use(express.static(staticDir, { maxAge: 0, etag: true }));

// ======== SSE (Feature 6) ========
app.get("/api/events", (_req, res) => {
  addSSEClient(res);
});

registerSettingsTasksRoutes(app);
registerWatcherRoutes(app);
registerConvertBatchRoutes(app);

app.get("/api/folders/tree", async (_req, res) => {
  res.json({ root: await listFolderTree() });
});

// ======== Scanner ========
app.post("/api/scan", async (_req, res) => {
  try {
    res.json(await scanAndEnqueue());
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.get("/api/scan/preview", async (_req, res) => {
  try {
    res.json(await previewLibraryScan());
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

registerJobsRoutes(app);
registerEmbeddedSubtitleRoutes(app);
registerCorrectionsRoutes(app);

// ======== Logs ========
app.get("/api/logs", (req, res) => {
  const query = parseLogsQuery(req.query);
  if (!query.ok) return res.status(400).json({ error: query.error });
  res.json(getLogs(query.value));
});

app.delete("/api/logs", (_req, res) => {
  clearLogs();
  logger.info("system", "Logs cleared");
  res.json({ ok: true });
});

registerModelsRoutes(app);
registerLlmStatusRoutes(app);
registerUsageRoutes(app);

registerTranscriptionRoutes(app);

const youtubeStore = new YoutubeStore(db, { notesRoot: getSetting("youtube_notes_dir") });
const youtubeWorker = new YoutubeWorker(youtubeStore);
registerYoutubeRoutes(app, youtubeStore, youtubeWorker);

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
  res.json({
    ok: true,
    queueRunning: isQueueRunning(),
    watcherRunning: getWatcherStatus().running,
  });
});

// ======== SPA Fallback ========
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"), { dotfiles: "allow" });
});

// ======== Start ========
app.listen(PORT, HOST, () => {
  // Reconcile any transcription attempts left "running" by a previous process
  // (e.g. crash/restart mid-transcription) so they no longer hang in history.
  const reconciled = transcriptionHistory.reconcileRunning();
  if (reconciled > 0) {
    logger.info("system", `Reconciled ${reconciled} interrupted transcription attempt(s) as failed`);
  }

  logger.info("system", `SubSmelt started on ${HOST}:${PORT}`);
  logger.info("system", `Timezone: ${process.env.TZ || "UTC"}`);
  logger.info("system", `Media directory: ${MEDIA_DIR}`);
  console.log(`\n  SubSmelt`);
  console.log(`  → http://localhost:${PORT}\n`);

  transcriptionWork.store.recover();
  transcriptionWork.start();
  syncWatcher();
  resumeQueueOnBoot();
  youtubeWorker.start();
});
