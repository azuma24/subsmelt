import type { Express } from "express";
import path from "node:path";
import { getAllSettings } from "../config.js";
import { MEDIA_DIR } from "../scanner.js";
import {
  assertMediaPathAllowed,
  buildTranscriptionRequest,
  fetchTranscriptionHealth,
  fetchTranscriptionLogs,
  preflightTranscription,
  type TranscribePostAction,
  type TranscriptionOutputFormat,
} from "../transcription-client.js";
import { logger } from "../logger.js";
import { getTranscriptionBackendUrl, inFlightTranscriptions, overridesFromBody } from "./transcription-runtime.js";
import { registerTranscriptionModelsRoutes } from "./transcription-models.js";
import { registerTranscriptionHistoryRoutes } from "./transcription-history-routes.js";
import { errorMessage } from "../errors.js";
import { transcriptionWork, validateWorkInput } from "../transcription/work.js";

// Re-exported so `src/server/index.ts` keeps working after the transcription
// engine moved to ./transcription-runtime.js.
export { getTranscriptionBackendUrl };

export function registerTranscriptionRoutes(app: Express): void {
  app.get("/api/transcribe/work", (_req, res) =>
    res.json({
      items: transcriptionWork.store.list().map(({ request: _request, content: _content, ...item }) => item),
    }),
  );
  app.get("/api/transcribe/work/:id", (req, res) => {
    const item = transcriptionWork.store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Transcription work not found" });
    const { request: _request, ...publicItem } = item;
    return res.json(publicItem);
  });
  app.post("/api/transcribe/work", (req, res) => {
    const inputs = req.body?.inputs;
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 500)
      return res.status(400).json({ error: "Expected 1–500 inputs" });
    try {
      const prepared = inputs.map((entry: unknown) => {
        if (!entry || typeof entry !== "object") throw new Error("Invalid input");
        const row = entry as Record<string, unknown>;
        const kind = row.kind;
        const input = row.input;
        if ((kind !== "file" && kind !== "url") || typeof input !== "string" || !input.trim())
          throw new Error("Invalid input");
        validateWorkInput(kind, input);
        return {
          kind: kind as "file" | "url",
          input,
          request:
            row.request && typeof row.request === "object" && !Array.isArray(row.request)
              ? (row.request as Record<string, unknown>)
              : {},
        };
      });
      const items = transcriptionWork.store.enqueue(prepared);
      transcriptionWork.start();
      return res.status(202).json({ items: items.map(({ request: _request, content: _content, ...item }) => item) });
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/transcribe/work/:id/cancel", (req, res) => {
    return transcriptionWork.cancel(req.params.id)
      ? res.json({ ok: true })
      : res.status(404).json({ error: "Active work not found" });
  });
  app.get("/api/transcribe/health", async (_req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    const selectedModel =
      typeof settings.transcription_model === "string" && settings.transcription_model.trim()
        ? settings.transcription_model.trim()
        : "small";
    if (!backendUrl) {
      return res.json({ ok: false, endpointReachable: false, reason: "endpoint-missing" });
    }
    try {
      const health = await fetchTranscriptionHealth(backendUrl, selectedModel, settings.transcription_backend_token);
      return res.json({ ok: true, endpointReachable: true, backendUrl, health });
    } catch (error) {
      return res.json({
        ok: false,
        endpointReachable: false,
        backendUrl,
        reason: "network-error",
        message: errorMessage(error) || "unknown",
      });
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
    } catch (error) {
      return res.json({
        ok: false,
        backendUrl,
        reason: "network-error",
        message: errorMessage(error) || "unknown",
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
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) || "Invalid media path" });
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
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) || "Transcription preflight failed" });
    }
  });

  // `path` is the id the run's progress events carry, a media path or the URL
  // of a URL run. Queued work for that input is cancelled with it, so it does
  // not start once the running attempt stops.
  app.post("/api/transcribe/cancel", (req, res) => {
    const runId = typeof req.body?.path === "string" ? req.body.path : "";
    if (!runId) return res.status(400).json({ error: "path is required" });
    const cancelledWork = transcriptionWork.cancelInput(runId);
    const controller = inFlightTranscriptions.get(runId);
    if (!cancelledWork && !controller)
      return res.status(404).json({ ok: false, error: "No in-flight transcription for that path" });
    controller?.abort();
    logger.info("system", `Cancellation requested for transcription ${path.basename(runId)}`);
    return res.json({ ok: true });
  });

  // Stops every queued and in-flight transcription, including runs outside the
  // work queue such as auto-transcriptions.
  app.post("/api/transcribe/cancel-all", (_req, res) => {
    let cancelled = transcriptionWork.cancelAll();
    for (const [runId, controller] of inFlightTranscriptions) {
      if (controller.signal.aborted) continue;
      controller.abort();
      logger.info("system", `Cancellation requested for transcription ${path.basename(runId)}`);
      cancelled += 1;
    }
    return res.json({ ok: true, cancelled });
  });

  registerTranscriptionModelsRoutes(app);
  registerTranscriptionHistoryRoutes(app);
}
