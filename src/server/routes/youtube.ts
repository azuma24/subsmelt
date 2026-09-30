import type { Express } from "express";
import { logger } from "../logger.js";
import { ffmpegVersion, resolveYtdlpBin, updateYtdlp, ytdlpVersion } from "../youtube/ytdlp.js";

export async function youtubeStatus() {
  const [ytdlp, ffmpeg] = await Promise.all([ytdlpVersion(), ffmpegVersion()]);
  return {
    ytdlp: { available: ytdlp !== null, version: ytdlp, path: resolveYtdlpBin() },
    ffmpeg: { available: ffmpeg !== null, version: ffmpeg },
  };
}

export function registerYoutubeRoutes(app: Express): void {
  app.get("/api/youtube/status", async (_req, res) => {
    res.json(await youtubeStatus());
  });

  app.post("/api/youtube/ytdlp/update", async (_req, res) => {
    try {
      const result = await updateYtdlp();
      logger.info("system", `yt-dlp updated: ${result.version ?? "unknown version"} at ${result.path}`);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("system", `yt-dlp update failed: ${message}`);
      res.status(500).json({ error: message });
    }
  });
}
