import type { Express } from "express";
import { getAllSettings } from "../config.js";
import {
  listBackendModels,
  downloadBackendModel,
  deleteBackendModel,
} from "../transcription-client.js";
import { logger } from "../logger.js";
import { broadcast } from "../sse.js";
import { getTranscriptionBackendUrl } from "./transcription-runtime.js";

// ======== Whisper Model Manager (proxy to whisper backend) ========
// The browser never talks to the whisper backend directly (it may live on
// another host with no CORS). These routes forward to the configured backend,
// attaching the shared-secret token, and relay download progress to the client
// over the existing SSE channel (event "model:download") for consistency with
// transcription progress.
export function registerTranscriptionModelsRoutes(app: Express): void {
  app.get("/api/whisper/models", async (_req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    try {
      const models = await listBackendModels(backendUrl, settings.transcription_backend_token);
      return res.json({ models });
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "Failed to list whisper models" });
    }
  });

  app.post("/api/whisper/models/download", async (req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (!model) return res.status(400).json({ error: "model is required" });
    // Reject anything outside a safe charset before forwarding to the backend —
    // blocks "../" path traversal and other injection into the model name.
    if (!/^[A-Za-z0-9._-]+$/.test(model)) {
      return res.status(400).json({ error: "Invalid model name" });
    }

    try {
      const result = await downloadBackendModel(backendUrl, model, {
        token: settings.transcription_backend_token,
        onProgress: ({ pct, downloadedMb, totalMb }) => {
          broadcast("model:download", { model, pct, downloadedMb, totalMb });
        },
      });
      broadcast("model:download", { model, pct: 100, done: true, cachePath: result.cachePath });
      logger.info("system", `Downloaded whisper model ${model}${result.cachePath ? ` → ${result.cachePath}` : ""}`);
      return res.json(result);
    } catch (error: any) {
      const message = error?.message || "Whisper model download failed";
      broadcast("model:download", { model, error: true, message });
      logger.error("system", `Whisper model download failed for ${model}: ${message}`);
      return res.status(502).json({ error: message });
    }
  });

  app.delete("/api/whisper/models/:model", async (req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    const model = typeof req.params.model === "string" ? req.params.model : "";
    if (!model) return res.status(400).json({ error: "model is required" });
    // Reject anything outside a safe charset before forwarding to the backend —
    // blocks "../" path traversal and other injection into the model name.
    if (!/^[A-Za-z0-9._-]+$/.test(model)) {
      return res.status(400).json({ error: "Invalid model name" });
    }
    try {
      const result = await deleteBackendModel(backendUrl, model, settings.transcription_backend_token);
      logger.info("system", `Deleted whisper model ${model}${typeof result.freedMb === "number" ? ` (freed ${result.freedMb} MB)` : ""}`);
      return res.json(result);
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "Failed to delete whisper model" });
    }
  });
}
