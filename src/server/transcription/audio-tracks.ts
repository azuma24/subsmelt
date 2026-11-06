import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { Express } from "express";
import { MEDIA_DIR } from "../scanner.js";
import { assertMediaPathAllowed } from "../transcription-client.js";

const runTool = promisify(execFile);
const inputFormats = "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpegts,ogg,wav,mp3,flac,aac";

interface ProbeAudioStream {
  index: number;
  codec_name?: string;
  disposition?: { default?: number };
  tags?: { language?: string; title?: string };
}

export function registerAudioTrackRoute(app: Express) {
  app.get("/api/transcribe/audio-tracks", async (req, res) => {
    const input = req.query.input;
    if (typeof input !== "string" || input.includes("\0"))
      return res.status(400).json({ error: "Select a library video" });
    let file: string;
    try {
      file = assertMediaPathAllowed(input, MEDIA_DIR);
      if (!(await stat(file)).isFile()) return res.status(400).json({ error: "Select a library video" });
    } catch {
      return res.status(400).json({ error: "Select a library video" });
    }
    try {
      const { stdout } = await runTool(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          inputFormats,
          "-select_streams",
          "a",
          "-show_entries",
          "stream=index,codec_name:stream_tags=language,title:stream_disposition=default",
          "-of",
          "json",
          file,
        ],
        { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      );
      const { streams = [] } = JSON.parse(stdout) as { streams?: ProbeAudioStream[] };
      return res.json({
        tracks: streams.map((stream) => ({
          index: stream.index,
          codec: stream.codec_name ?? "",
          language: stream.tags?.language?.slice(0, 30) ?? "",
          title: stream.tags?.title?.slice(0, 160) ?? "",
          isDefault: stream.disposition?.default === 1,
        })),
      });
    } catch {
      return res.status(422).json({ error: "Could not inspect audio tracks" });
    }
  });
}
