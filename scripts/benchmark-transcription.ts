import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { transcribeFileWithBackendUpload } from "../src/server/transcription/http-upload.js";
import type { BackendTranscriptionRequest } from "../src/server/transcription/types.js";
import type { TranscriptionTimings } from "../src/shared/transcription.js";

const USAGE =
  "Usage: npx tsx scripts/benchmark-transcription.ts <backend-url> <media-file> " +
  "[--audio-stream <index>] [--model <id>] [--language <code>] [--device <device>] " +
  "[--compute-type <type>] [--rounds <count>] [--no-vad]";

function integer(value: string | undefined, minimum: number, maximum: number, option: string): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${option} requires an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "audio-stream": { type: "string" },
      model: { type: "string", default: "small" },
      language: { type: "string", default: "auto" },
      device: { type: "string", default: "cpu" },
      "compute-type": { type: "string", default: "int8" },
      rounds: { type: "string", default: "1" },
      "no-vad": { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 2) throw new Error(USAGE);
  const [backendUrl, media] = positionals;
  const input = path.resolve(media);
  const rounds = integer(values.rounds, 1, 10, "--rounds") ?? 1;
  const request: BackendTranscriptionRequest = {
    input_path: input,
    model: values.model,
    language: values.language,
    device: values.device,
    compute_type: values["compute-type"],
    output_format: "srt",
    use_vad: !values["no-vad"],
    post_action: "transcribe_only",
    force_recognition: true,
    audio_stream_index: integer(values["audio-stream"], 0, 2_147_483_647, "--audio-stream"),
  };
  const token = process.env.WHISPER_BACKEND_TOKEN || process.env.SUBSMELT_WHISPER_TOKEN;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  for (let round = 1; round <= rounds; round++) {
    const runs = [];
    // Reverse the order in alternating rounds to distribute cold model loads.
    for (const audioOnlyUpload of round % 2 === 1 ? [false, true] : [true, false]) {
      const timingsMs: TranscriptionTimings = {};
      let uploadedBytes: number | undefined;
      let audioOnlyUploaded: boolean | undefined;
      const started = performance.now();
      const result = await transcribeFileWithBackendUpload(backendUrl, request, input, {
        token,
        signal: controller.signal,
        audioOnlyUpload,
        onMetrics(metrics) {
          Object.assign(timingsMs, metrics.timingsMs);
        },
        onUploadPrepared(bytes, audioOnly) {
          uploadedBytes = bytes;
          audioOnlyUploaded = audioOnly;
        },
      });
      if (!result.ok || typeof result.content !== "string") throw new Error("Backend returned no transcript content");
      runs.push({
        requested: audioOnlyUpload ? "audio-only" : "full-media",
        elapsedMs: Math.round(performance.now() - started),
        timingsMs,
        uploadedBytes,
        audioOnlyUploaded,
        audioDurationSeconds: result.duration_seconds,
        language: result.language,
        segments: result.segments,
        subtitleSha256: createHash("sha256").update(result.content).digest("hex"),
      });
    }
    console.log(JSON.stringify({ round, sameSubtitle: runs[0].subtitleSha256 === runs[1].subtitleSha256, runs }));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = message === "Transcription cancelled" ? 130 : 1;
});
