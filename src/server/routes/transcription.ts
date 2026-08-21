import type { Express } from "express";
import path from "node:path";
import { getAllSettings } from "../config.js";
import { scanFolder, MEDIA_DIR } from "../scanner.js";
import { processQueue } from "../queue.js";
import {
  assertMediaPathAllowed,
  buildTranscriptionRequest,
  fetchTranscriptionHealth,
  fetchTranscriptionLogs,
  preflightTranscription,
  transcribePostActionValues,
  transcribeTimeoutSeconds,
  transcribeUrlWithBackendStreaming,
  type TranscribePostAction,
  type TranscriptionOutputFormat,
} from "../transcription-client.js";
import { logger } from "../logger.js";
import { broadcast } from "../sse.js";
import {
  getTranscriptionBackendUrl,
  inFlightTranscriptions,
  overridesFromBody,
  runTranscriptionAttempt,
  transcriptionErrorStatus,
} from "./transcription-runtime.js";
import { registerTranscriptionModelsRoutes } from "./transcription-models.js";
import { registerTranscriptionHistoryRoutes } from "./transcription-history-routes.js";

// Re-exported so existing importers (`src/server/index.ts`) keep working
// unchanged after the transcription engine moved to ./transcription-runtime.js.
export { getTranscriptionBackendUrl, runTranscriptionAttempt, transcriptionErrorStatus };

export function registerTranscriptionRoutes(app: Express): void {
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
      const health = await fetchTranscriptionHealth(backendUrl, selectedModel, settings.transcription_backend_token);
      return res.json({ ok: true, endpointReachable: true, backendUrl, health });
    } catch (error: any) {
      return res.json({ ok: false, endpointReachable: false, backendUrl, reason: "network-error", message: error?.message || "unknown" });
    }
  });

  // Proxy the Whisper backend's log tail. The backend logs to a file on its own
  // host — unreachable from the app UI, and on Windows unreachable without
  // sitting at the machine. Mirrors the health route's shape (never throws; a
  // dead backend is reported as data) so the Logs page can render the reason.
  app.get("/api/transcription/logs", async (req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) {
      return res.json({ ok: false, reason: "endpoint-missing", lines: [] });
    }
    const requested = parseInt(String(req.query.lines ?? "200"), 10);
    const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 2000) : 200;
    try {
      const body = await fetchTranscriptionLogs(backendUrl, lines, settings.transcription_backend_token);
      return res.json({ ok: true, backendUrl, ...(body as Record<string, unknown>) });
    } catch (error: any) {
      return res.json({
        ok: false,
        backendUrl,
        reason: "network-error",
        message: error?.message || "unknown",
        lines: [],
      });
    }
  });

  app.post("/api/transcribe/preflight", async (req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    const videoPath = typeof req.body?.videoPath === "string" ? req.body.videoPath : "";
    if (!videoPath) return res.status(400).json({ error: "videoPath is required" });
    // Validate the path is inside MEDIA_DIR before any downstream processing.
    try {
      assertMediaPathAllowed(videoPath, MEDIA_DIR);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Invalid media path" });
    }
    try {
      const request = buildTranscriptionRequest({
        videoPath,
        mediaDir: MEDIA_DIR,
        settings,
        outputFormat: req.body?.outputFormat as TranscriptionOutputFormat | undefined,
        postAction: req.body?.postAction as TranscribePostAction | undefined,
        overrides: overridesFromBody(req.body),
      });
      const result = await preflightTranscription(backendUrl, request, settings.transcription_backend_token);
      return res.json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Transcription preflight failed" });
    }
  });

  app.post("/api/transcribe", async (req, res) => {
    const settings = getAllSettings();
    const videoPath = typeof req.body?.videoPath === "string" ? req.body.videoPath : "";
    if (!videoPath) return res.status(400).json({ error: "videoPath is required" });
    // Validate the path is inside MEDIA_DIR before it is recorded in history,
    // broadcast over SSE, or used as a map key by any downstream processing.
    try {
      assertMediaPathAllowed(videoPath, MEDIA_DIR);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Invalid media path" });
    }
    const requestedPostAction = req.body?.postAction as TranscribePostAction | undefined;
    const postAction = requestedPostAction && transcribePostActionValues.includes(requestedPostAction) ? requestedPostAction : "transcribe_only";

    try {
      const { result, attemptId } = await runTranscriptionAttempt({
        videoPath,
        postAction,
        outputFormat: req.body?.outputFormat as TranscriptionOutputFormat | undefined,
        overrides: overridesFromBody(req.body),
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
      // 502 when the backend itself failed/was unreachable; 400 for client errors.
      return res.status(transcriptionErrorStatus(error)).json({ error: error?.message || "Transcription failed" });
    }
  });

  // Transcribe remote media (YouTube etc.). The backend fetches via yt-dlp; no
  // local media file is involved, so the rendered subtitle content is returned to
  // the client (which downloads it) rather than written next to a library file.
  app.post("/api/transcribe/url", async (req, res) => {
    const settings = getAllSettings();
    if (settings.transcription_enabled !== "1") return res.status(400).json({ error: "Speech-to-text is disabled in settings" });
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    const b = (req.body || {}) as Record<string, unknown>;
    const url = typeof b.url === "string" ? b.url.trim() : "";
    if (!url) return res.status(400).json({ error: "url is required" });
    // Only http(s) — reject file:/smb:/ftp:/data: before forwarding to yt-dlp.
    let parsedUrl: URL | null = null;
    try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
    if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
      return res.status(400).json({ error: "Only http:// and https:// URLs are allowed" });
    }
    const pick = (k: string, fb: string): string => (typeof b[k] === "string" && b[k] ? (b[k] as string) : fb);

    const outputFormat = pick("outputFormat", settings.transcription_output_format || "srt");
    const body: Record<string, unknown> = {
      url,
      output_format: outputFormat,
      model: pick("model", settings.transcription_model || "small"),
      language: pick("language", settings.transcription_language || "auto"),
      device: pick("device", settings.transcription_device || "cpu"),
      compute_type: pick("computeType", settings.transcription_compute_type || "int8"),
      post_action: "transcribe_only",
      ...(b.speakerDiarization === true ? { advanced_options: { speaker_diarization: true } } : {}),
    };

    // Relay progress/phase to the UI keyed by the URL (acts as the row id).
    const onProgress = ({ pct, processedSeconds, totalSeconds }: { pct: number; processedSeconds: number; totalSeconds: number }) =>
      broadcast("transcription:progress", { path: url, pct, processedSeconds, totalSeconds });
    const onPhase = (phase: string) => broadcast("transcription:progress", { path: url, phase });

    try {
      const result = await transcribeUrlWithBackendStreaming(backendUrl, body, {
        timeoutSeconds: transcribeTimeoutSeconds(settings),
        token: settings.transcription_backend_token,
        onProgress,
        onPhase,
      });
      broadcast("transcription:progress", { path: url, pct: 100, done: true });
      const content = (result as unknown as { content?: string }).content ?? "";
      return res.json({ ok: true, content, language: result.language, segments: result.segments, outputFormat, url });
    } catch (error: any) {
      broadcast("transcription:progress", { path: url, error: true });
      logger.error("system", `URL transcription failed: ${error?.message || error}`);
      // 502 when the backend itself failed/was unreachable; 400 for client errors.
      return res.status(transcriptionErrorStatus(error)).json({ error: error?.message || "URL transcription failed" });
    }
  });

  app.post("/api/transcribe/cancel", (req, res) => {
    const videoPath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!videoPath) return res.status(400).json({ error: "path is required" });
    // Validate the path is inside MEDIA_DIR before using it as a map key.
    try {
      assertMediaPathAllowed(videoPath, MEDIA_DIR);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Invalid media path" });
    }
    const entry = inFlightTranscriptions.get(videoPath);
    if (!entry) return res.status(404).json({ ok: false, error: "No in-flight transcription for that path" });
    entry.controller.abort();
    logger.info("system", `Cancellation requested for transcription ${path.basename(videoPath)}`);
    return res.json({ ok: true });
  });

  registerTranscriptionModelsRoutes(app);
  registerTranscriptionHistoryRoutes(app);
}
