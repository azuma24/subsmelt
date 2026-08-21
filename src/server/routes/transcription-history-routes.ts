import type { Express } from "express";
import path from "node:path";
import { scanFolder, MEDIA_DIR } from "../scanner.js";
import { processQueue } from "../queue.js";
import { assertMediaPathAllowed } from "../transcription-client.js";
import { transcriptionHistory } from "../transcription-history.js";
import { logger } from "../logger.js";
import { runTranscriptionAttempt, transcriptionErrorStatus } from "./transcription-runtime.js";

// ======== Transcription history (list/clear/retry) ========
export function registerTranscriptionHistoryRoutes(app: Express): void {
  app.get("/api/transcribe/history", (req, res) => {
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
    res.json({ attempts: transcriptionHistory.listRecent(Number.isFinite(limit) ? limit : 20) });
  });

  // Clears finished attempts only — an in-flight attempt keeps its entry so the
  // running transcription can still report its result.
  app.delete("/api/transcribe/history", (_req, res) => {
    const removed = transcriptionHistory.clear();
    logger.info("system", `Cleared ${removed} transcription history ${removed === 1 ? "entry" : "entries"}`);
    res.json({ ok: true, removed });
  });

  app.delete("/api/transcribe/history/:id", (req, res) => {
    if (!transcriptionHistory.remove(req.params.id)) {
      return res.status(404).json({ error: "Transcription attempt not found" });
    }
    return res.json({ ok: true, removed: 1 });
  });

  app.post("/api/transcribe/history/:id/retry", async (req, res) => {
    const attempt = transcriptionHistory.get(req.params.id);
    if (!attempt) return res.status(404).json({ error: "Transcription attempt not found" });
    // Re-validate the stored input path against the CURRENT MEDIA_DIR before
    // re-running — MEDIA_DIR (or the stored path) may have changed since the
    // original attempt.
    try {
      assertMediaPathAllowed(attempt.inputPath, MEDIA_DIR);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Invalid media path" });
    }
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
      // 502 when the backend itself failed/was unreachable; 400 for client errors.
      return res.status(transcriptionErrorStatus(error)).json({ error: error?.message || "Transcription retry failed" });
    }
  });
}
