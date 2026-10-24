import type { Express } from "express";
import { transcriptionHistory } from "../transcription-history.js";
import { logger } from "../logger.js";

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
}
