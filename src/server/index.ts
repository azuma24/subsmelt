import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import asyncPool from "tiny-async-pool";
import {
  getAllSettings,
  setSetting,
  getSetting,
} from "./config.js";
import { scanFolder, listFolderTree, MEDIA_DIR } from "./scanner.js";
import {
  runQueueSafely,
  isQueueRunning,
  startAutoScan,
  resumeQueueOnBoot,
} from "./queue.js";
import { noSpeechVideos, transcriptionHistory } from "./transcription-history.js";
import { logger } from "./logger.js";
import { crossSiteGuard } from "./cross-site-guard.js";
import db, { getLogs, clearLogs } from "./db.js";
import { addSSEClient, broadcast } from "./sse.js";
import { notifyTest } from "./notify.js";
import { startWatcher, stopWatcher, isWatcherRunning } from "./watcher.js";
import { parseLogsQuery } from "./routes/validation.js";
import { readSettings } from "./settings-schema.js";
import type { TranscribePostAction } from "./transcription-client.js";
import { registerSettingsTasksRoutes } from "./routes/settings-tasks.js";
import { registerJobsRoutes } from "./routes/jobs.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerLlmStatusRoutes } from "./routes/llm-status.js";
import { registerYoutubeRoutes } from "./routes/youtube.js";
import { YoutubeStore } from "./youtube/store.js";
import { YoutubeWorker } from "./youtube/worker.js";
import {
  registerTranscriptionRoutes,
  getTranscriptionBackendUrl,
  runTranscriptionAttempt,
} from "./routes/transcription.js";
import {
  claimAutoTranscriptions,
  releaseAutoTranscription,
} from "./auto-transcription.js";
import { TranscriptionInFlightError } from "./transcription/in-flight.js";
import { NoSpeechError } from "./routes/transcription-runtime.js";
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
app.use(cors({ origin: false }));
// CORS hides responses, but a foreign page can still fire a simple POST; this
// refuses those before any route acts on them.
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
app.use(
  "/assets",
  express.static(path.join(staticDir, "assets"), { immutable: true, maxAge: "1y", index: false }),
);
app.use(express.static(staticDir, { maxAge: 0, etag: true }));

// ======== SSE (Feature 6) ========
app.get("/api/events", (_req, res) => {
  addSSEClient(res);
});

registerSettingsTasksRoutes(app);

app.get("/api/folders/tree", async (_req, res) => {
  res.json({ root: await listFolderTree() });
});

// ======== Scanner ========
// One walk of the media tree at a time: concurrent callers share the run
// already in flight and receive its result instead of starting another.
let scanInFlight: ReturnType<typeof scanFolder> | null = null;

app.post("/api/scan", async (_req, res) => {
  if (scanInFlight) {
    // A walk is already running: share it instead of queueing another
    // full-tree walk behind it.
    try {
      return res.json(await scanInFlight);
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) });
    }
  }
  const run = (async (): ReturnType<typeof scanFolder> => {
    let result = await scanFolder(true);
    const settings = getAllSettings();
    const typed = readSettings();
    const behavior = typed.transcription_missing_subtitle_behavior;
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (typed.transcription_enabled && backendUrl && behavior !== "ask") {
      const postAction: TranscribePostAction =
        behavior === "auto_transcribe_and_translate"
          ? "transcribe_and_translate"
          : "transcribe_only";
      // Claimed in the same tick as the scan, so an overlapping scan either
      // finds a video claimed here or already sees its new subtitle.
      const missingVideos = claimAutoTranscriptions(
        result.files
          // A video a run found silent is not retried until it changes.
          .filter((file) => file.videoPath && file.subtitles.length === 0 && !noSpeechVideos.has(file.videoPath))
          .map((file) => file.videoPath as string),
      );
      // Per-file isolation: a single failure must NOT abort the whole scan
      // batch. Each file is transcribed through runTranscriptionAttempt (which
      // records a history entry and acquires the shared concurrency slot), and
      // any hard failure is caught + logged here so remaining files continue.
      // Bound the fan-out so a huge library doesn't spin up hundreds of attempts
      // (each registering a history row + in-flight entry) before the slot gate
      // can even hold them back.
      const scanConcurrency = typed.transcription_max_concurrent;
      for await (const _ of asyncPool(
        scanConcurrency,
        missingVideos,
        async (videoPath) => {
          try {
            const { result: transcribed } = await runTranscriptionAttempt({
              videoPath,
              postAction,
              settings,
            });
            logger.info(
              "system",
              `Auto-transcribed ${path.basename(videoPath)} → ${transcribed.subtitle_path || "subtitle output"}`,
            );
          } catch (error) {
            const message = errorMessage(error) || String(error);
            if (error instanceof NoSpeechError) {
              logger.info(
                "system",
                `Auto-transcription of ${path.basename(videoPath)} found no speech; later scans skip it`,
              );
              return;
            }
            if (error instanceof TranscriptionInFlightError) {
              // Someone started this video by hand after the scan queued it.
              logger.info(
                "system",
                `Skipped auto-transcription for ${path.basename(videoPath)}: already being transcribed`,
              );
              return;
            }
            if (typed.transcription_low_ram_behavior === "skip" && message.startsWith("Transcription skipped:")) {
              logger.info(
                "system",
                `Skipped auto-transcription for ${path.basename(videoPath)}: ${message}`,
              );
              return;
            }
            logger.error(
              "system",
              `Auto-transcription failed for ${path.basename(videoPath)}: ${message}`,
            );
          } finally {
            releaseAutoTranscription(videoPath);
          }
        },
      )) {
        // Drain the concurrency pool; per-file errors are handled in the iterator.
      }
      if (missingVideos.length > 0) {
        result = await scanFolder(postAction === "transcribe_and_translate");
      }
    }
    if (result.newJobs > 0 && getSetting("auto_translate") === "1") {
      setTimeout(() => runQueueSafely(), 100);
    }
    broadcast("scan:complete", {
      newJobs: result.newJobs,
      total: result.totalSubtitles,
    });
    return result;
  })();
  scanInFlight = run;
  try {
    res.json(await run);
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  } finally {
    scanInFlight = null;
  }
});

app.get("/api/scan/preview", async (_req, res) => {
  try {
    res.json(await scanFolder(false));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
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

registerTranscriptionRoutes(app);

const youtubeStore = new YoutubeStore(db);
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
    watcherRunning: isWatcherRunning(),
  });
});

// ======== SPA Fallback ========
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

// ======== Start ========
app.listen(PORT, HOST, () => {
  // Reconcile any transcription attempts left "running" by a previous process
  // (e.g. crash/restart mid-transcription) so they no longer hang in history.
  const reconciled = transcriptionHistory.reconcileRunning();
  if (reconciled > 0) {
    logger.info(
      "system",
      `Reconciled ${reconciled} interrupted transcription attempt(s) as failed`,
    );
  }

  logger.info("system", `SubSmelt started on ${HOST}:${PORT}`);
  logger.info("system", `Timezone: ${process.env.TZ || "UTC"}`);
  logger.info("system", `Media directory: ${MEDIA_DIR}`);
  console.log(`\n  SubSmelt`);
  console.log(`  → http://localhost:${PORT}\n`);

  const interval = parseInt(getSetting("auto_scan_interval") || "0", 10);
  if (interval > 0) startAutoScan(interval, scanFolder);
  if (getSetting("watch_enabled") === "1") startWatcher();
  resumeQueueOnBoot();
  youtubeWorker.start();
});
