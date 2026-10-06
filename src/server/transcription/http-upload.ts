// Upload transport (Model B, plan Phase 2) and URL/YouTube transport: the
// media bytes (or a remote URL) are sent to the backend and it returns the
// subtitle CONTENT directly, rather than reading/writing a shared filesystem
// path. Both transports share the NDJSON progress protocol consumed by
// postTranscriptionStream (http-shared.ts).

import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  BackendTranscriptionRequest,
  BackendTranscriptionResponse,
  TranscribeBackendOptions,
  TranscribeStreamingOptions,
} from "./types.js";
import {
  fetchWithTimeout,
  normalizeTranscriptionBackendUrl,
  postTranscriptionStream,
  resolveTranscribeTimeoutMs,
  throwBackendError,
  transcriptionAuthHeaders,
} from "./http-shared.js";

// Hard cap on upload-transport file size (5 GB). Larger files must use shared-FS
// transport; uploading them risks exhausting memory/disk on either end.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

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
  const response = await fetchWithTimeout(`${url}/transcribe/upload`, {
    method: "POST",
    headers: { ...transcriptionAuthHeaders(options?.token) },
    body: form,
    signal: options?.signal,
  }, timeoutMs, "Transcription backend upload");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
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
  return postTranscriptionStream(`${url}/transcribe/upload/stream`, {
    headers: { ...transcriptionAuthHeaders(options?.token) },
    body: form,
  }, "Transcription backend upload stream", options);
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
  return postTranscriptionStream(`${url}/transcribe/url/stream`, {
    headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
    body: JSON.stringify(body),
  }, "Transcription backend URL stream", options);
}
