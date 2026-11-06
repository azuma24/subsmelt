import type { Express } from "express";
import { canProbeEmbeddedSubtitles } from "../../shared/embedded-subtitles.js";
import { EmbeddedSubtitleError, extractTrack, probeVideo } from "../embedded-subtitles.js";
import { ocrEmbeddedSubtitle, subtitleOcrAvailable, supportsSubtitleOcr } from "../subtitle-ocr.js";
import { MEDIA_DIR } from "../scanner.js";
import { assertMediaPathAllowed } from "../transcription/request.js";

function allowedVideo(input: unknown): string {
  if (typeof input !== "string" || !canProbeEmbeddedSubtitles(input) || input.includes("\0")) {
    throw new EmbeddedSubtitleError(400, "Select a video in the Library.");
  }
  try {
    return assertMediaPathAllowed(input, MEDIA_DIR);
  } catch {
    throw new EmbeddedSubtitleError(400, "Select a video in the Library.");
  }
}

export function registerEmbeddedSubtitleRoutes(app: Express): void {
  app.get("/api/library/embedded-subtitles", async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const probe = await probeVideo(allowedVideo(req.query.videoPath), { signal: controller.signal });
      if (probe.tracks.some(supportsSubtitleOcr)) {
        const ocr = (await subtitleOcrAvailable(controller.signal)) ? "available" : "unavailable";
        for (const track of probe.tracks) {
          if (supportsSubtitleOcr(track)) track.ocr = ocr;
        }
      }
      res.json(probe);
    } catch (error) {
      if (controller.signal.aborted) return;
      const known = error instanceof EmbeddedSubtitleError;
      res.status(known ? error.status : 500).json({ error: known ? error.message : "Could not inspect this video." });
    }
  });

  app.post("/api/library/embedded-subtitles", async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const { videoPath, index, revision, ocr } = req.body ?? {};
      if (!Number.isSafeInteger(index) || index < 0 || typeof revision !== "string") {
        throw new EmbeddedSubtitleError(400, "Select an embedded subtitle track.");
      }
      const file = allowedVideo(videoPath);
      const current = await probeVideo(file, { signal: controller.signal });
      if (current.revision !== revision) throw new EmbeddedSubtitleError(412, "The video changed.");
      const track = current.tracks.find((entry) => entry.index === index);
      if (!track) throw new EmbeddedSubtitleError(400, "This subtitle track was not found in the video.");
      const result =
        ocr === true
          ? await ocrEmbeddedSubtitle(file, current.revision, track, controller.signal)
          : await extractTrack(file, current.revision, track, { signal: controller.signal });
      res.json(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      const known = error instanceof EmbeddedSubtitleError;
      res
        .status(known ? error.status : 500)
        .json({ error: known ? error.message : "Could not save the subtitle file." });
    }
  });
}
