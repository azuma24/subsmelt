// Upload transport (Model B, plan Phase 2) and URL/YouTube transport: the
// media bytes (or a remote URL) are sent to the backend and it returns the
// subtitle CONTENT directly, rather than reading/writing a shared filesystem
// path. Both transports share the NDJSON progress protocol consumed by
// postTranscriptionStream (http-shared.ts).

import { execFile } from "node:child_process";
import { openAsBlob } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  BackendTranscriptionRequest,
  BackendTranscriptionResponse,
  TranscribeBackendOptions,
  TranscribeStreamingOptions,
} from "./types.js";
import {
  assertAudioStreamSupport,
  fetchWithTimeout,
  normalizeTranscriptionBackendUrl,
  postTranscriptionStream,
  relayTranscriptionMetrics,
  resolveTranscribeTimeoutMs,
  StreamingUnsupportedError,
  throwBackendError,
  transcriptionAuthHeaders,
} from "./http-shared.js";

// Hard cap on upload-transport file size (5 GB). Larger files must use shared-FS
// transport; uploading them risks exhausting memory/disk on either end.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

const runFfmpeg = promisify(execFile);
const AUDIO_INPUT_FORMATS =
  "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpeg,mpegts,flv,asf,ogg,wav,mp3,aac,flac,ac3,aiff";

interface FileUploadOptions extends TranscribeStreamingOptions {
  audioOnlyUpload?: boolean;
  onUploadPrepared?: (bytes: number, audioOnly: boolean) => void;
}

/**
 * Losslessly pack the same 16 kHz mono PCM used by the backend. An explicit
 * stream keeps its offset from media start, including any leading silence.
 */
async function packAudio(
  source: string,
  output: string,
  streamIndex: number | undefined,
  options: FileUploadOptions,
): Promise<void> {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    AUDIO_INPUT_FORMATS,
    "-i",
    path.resolve(source),
  ];
  if (streamIndex !== undefined) {
    args.push("-map", `0:${streamIndex}`, "-af", "aresample=16000:async=1:first_pts=0");
  }
  args.push(
    "-vn",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-sample_fmt",
    "s16",
    "-c:a",
    "flac",
    "-compression_level",
    "1",
    "-f",
    "flac",
    output,
  );
  await runFfmpeg(process.env.SUBSMELT_FFMPEG || "ffmpeg", args, {
    signal: options.signal,
    timeout: resolveTranscribeTimeoutMs(options.timeoutSeconds),
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
}

/** Prepare one payload and keep it for either the stream route or the older JSON route. */
export async function transcribeFileWithBackendUpload(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  filePath: string,
  options: FileUploadOptions,
): Promise<BackendTranscriptionResponse> {
  let temp: string | undefined;
  try {
    const file = await stat(filePath, { bigint: true });
    let source = filePath;
    let size = Number(file.size);
    let outgoing = request;
    if (options.audioOnlyUpload) {
      const started = performance.now();
      let packed: string | undefined;
      try {
        temp = await mkdtemp(path.join(tmpdir(), "subsmelt-audio-"));
        const candidate = path.join(temp, "audio.flac");
        await packAudio(filePath, candidate, request.audio_stream_index, options);
        packed = candidate;
      } catch {
        if (options.signal?.aborted) throw new Error("Transcription cancelled");
        // Local packing did not complete. Fall back before sending any bytes.
        // An explicit stream still needs support on the receiving backend.
      } finally {
        options.onMetrics?.({ timingsMs: { uploadPrepare: Math.round(performance.now() - started) } });
      }
      if (packed) {
        const current = await stat(filePath, { bigint: true });
        if (
          file.dev !== current.dev ||
          file.ino !== current.ino ||
          file.size !== current.size ||
          file.mtimeNs !== current.mtimeNs ||
          file.ctimeNs !== current.ctimeNs
        ) {
          throw new Error("Media file changed while preparing audio upload");
        }
        const packedSize = (await stat(packed)).size;
        if (
          packedSize > 0 &&
          packedSize < MAX_UPLOAD_BYTES &&
          (request.audio_stream_index !== undefined || packedSize < size)
        ) {
          const { audio_stream_index: index, ...rest } = request;
          outgoing = { ...rest, ...(index !== undefined ? { source_audio_stream_index: index } : {}) };
          source = packed;
          size = packedSize;
        }
      }
    }
    await assertAudioStreamSupport(backendUrl, outgoing.audio_stream_index, options);
    options.onUploadPrepared?.(size, source !== filePath);
    try {
      return await transcribeWithBackendUploadStreaming(backendUrl, outgoing, source, options);
    } catch (error) {
      if (!(error instanceof StreamingUnsupportedError)) throw error;
      return await transcribeWithBackendUpload(backendUrl, outgoing, source, options);
    }
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

// Builds the multipart body: the request JSON (minus input_path, which is
// meaningless server-side in upload mode) plus the media file.
async function buildUploadForm(request: BackendTranscriptionRequest, filePath: string): Promise<FormData> {
  const { input_path: _ignored, ...rest } = request;
  const { size } = await stat(filePath);
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Media file is too large to upload (${size} bytes > ${MAX_UPLOAD_BYTES} byte cap); use shared-filesystem transport instead`,
    );
  }
  const blob = await openAsBlob(filePath);
  const form = new FormData();
  form.append("request", JSON.stringify(rest));
  form.append("file", blob, path.basename(filePath));
  return form;
}

/**
 * Upload transport, non-streaming: POSTs the media file + request to
 * /transcribe/upload and returns the response carrying subtitle `content`.
 */
export async function transcribeWithBackendUpload(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  filePath: string,
  options?: TranscribeBackendOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const timeoutMs = resolveTranscribeTimeoutMs(options?.timeoutSeconds);
  const form = await buildUploadForm(request, filePath);
  const response = await fetchWithTimeout(
    `${url}/transcribe/upload`,
    {
      method: "POST",
      headers: { ...transcriptionAuthHeaders(options?.token) },
      body: form,
      signal: options?.signal,
    },
    timeoutMs,
    "Transcription backend upload",
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  relayTranscriptionMetrics(body, options);
  return body as BackendTranscriptionResponse;
}

/**
 * Upload transport, streaming: POSTs the media file + request to
 * /transcribe/upload/stream and consumes the NDJSON progress protocol. Aborting
 * the signal closes the stream → backend cancels. A 404 (older backend without
 * the upload route) throws StreamingUnsupportedError so callers can react.
 */
export async function transcribeWithBackendUploadStreaming(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  filePath: string,
  options?: TranscribeStreamingOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const form = await buildUploadForm(request, filePath);
  const started = performance.now();
  return postTranscriptionStream(
    `${url}/transcribe/upload/stream`,
    {
      headers: { ...transcriptionAuthHeaders(options?.token) },
      body: form,
    },
    "Transcription backend upload stream",
    {
      ...options,
      onHeaders(response) {
        options?.onHeaders?.(response);
        if (!response.ok) return;
        const timing = response.headers.get("server-timing") || "";
        const preflight = Number(/(?:^|, )preflight;dur=(\d+)/.exec(timing)?.[1] ?? 0);
        const save = Number(/(?:^|, )save;dur=(\d+)/.exec(timing)?.[1] ?? 0);
        options?.onMetrics?.({
          timingsMs: { upload: Math.max(0, Math.round(performance.now() - started) - preflight - save) },
        });
      },
    },
  );
}

/**
 * URL/YouTube transport, streaming: POSTs a JSON body {url, ...request fields}
 * to /transcribe/url/stream (backend fetches via yt-dlp) and consumes the same
 * NDJSON progress protocol, returning the subtitle content.
 */
export async function transcribeUrlWithBackendStreaming(
  backendUrl: string,
  body: Record<string, unknown>,
  options?: TranscribeStreamingOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  return postTranscriptionStream(
    `${url}/transcribe/url/stream`,
    {
      headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
      body: JSON.stringify(body),
    },
    "Transcription backend URL stream",
    options,
  );
}
