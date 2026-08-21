// Upload transport (Model B, plan Phase 2) and URL/YouTube transport: the
// media bytes (or a remote URL) are sent to the backend and it returns the
// subtitle CONTENT directly, rather than reading/writing a shared filesystem
// path. Both transports share the same NDJSON progress protocol, so the
// consumer is factored out once (consumeTranscriptionNdjson) and reused below.

import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  BackendTranscriptionRequest,
  BackendTranscriptionResponse,
  TranscribeBackendOptions,
  TranscribeStreamingOptions,
  TranscriptionProgressUpdate,
} from "./types.js";
import {
  abortReasonError,
  fetchWithTimeout,
  normalizeTranscriptionBackendUrl,
  parseNdjsonLine,
  resolveTranscribeTimeoutMs,
  StreamingUnsupportedError,
  throwBackendError,
  toProgressUpdate,
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

// Parses an NDJSON transcription stream (shared by upload streaming below).
// Progress lines drive onProgress; the terminal "result" line is returned; an
// "error" line throws. Mirrors the consumer in transcribeWithBackendStreaming.
async function consumeTranscriptionNdjson(
  body: ReadableStream<Uint8Array>,
  onProgress?: (update: TranscriptionProgressUpdate) => void,
  onPhase?: (phase: string) => void,
  // Internal controller signal (fires on external cancel OR timeout) so a torn-down
  // stream surfaces a clear message rather than "ended without result".
  signal?: AbortSignal,
  // External (caller) signal + timeout context to tell cancel apart from timeout.
  externalSignal?: AbortSignal,
  label = "Transcription backend stream",
  timeoutMs = 0,
): Promise<BackendTranscriptionResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let result: BackendTranscriptionResponse | null = null;
  let streamError: string | null = null;

  const handleLine = (line: string): void => {
    const record = parseNdjsonLine(line);
    if (!record) return;
    const type = record.type;
    if (type === "progress") {
      const update = toProgressUpdate(record);
      if (update && onProgress) onProgress(update);
    } else if (type === "phase") {
      if (typeof record.phase === "string" && onPhase) onPhase(record.phase);
    } else if (type === "result") {
      const { type: _t, ...rest } = record;
      result = rest as unknown as BackendTranscriptionResponse;
    } else if (type === "error") {
      streamError = typeof record.error === "string" ? record.error : "Transcription failed";
    }
  };

  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
  } catch (error: unknown) {
    // Aborting the request rejects the stream iterator with AbortError; map it to
    // cancellation (external signal) or a timeout error (internal timer fired).
    if (error instanceof Error && error.name === "AbortError") {
      throw abortReasonError(externalSignal, label, timeoutMs);
    }
    throw error;
  }

  if (streamError) {
    const err = new Error(streamError);
    (err as Error & { backendStatus?: number }).backendStatus = 500;
    throw err;
  }
  if (!result) {
    // The stream ended cleanly without a result line. If an abort was involved
    // (race where iteration finished as the signal fired), report cancellation
    // or timeout rather than a confusing "ended without result".
    if (signal?.aborted) throw abortReasonError(externalSignal, label, timeoutMs);
    throw new Error("Transcription stream ended without a result");
  }
  return result;
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

  const timeoutMs = resolveTranscribeTimeoutMs(options?.timeoutSeconds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const form = await buildUploadForm(request, filePath);
  let response: Response;
  try {
    response = await fetch(`${url}/transcribe/upload/stream`, {
      method: "POST",
      headers: { ...transcriptionAuthHeaders(options?.token) },
      body: form,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (error instanceof Error && error.name === "AbortError") {
      throw abortReasonError(externalSignal, "Transcription backend upload stream", timeoutMs);
    }
    throw error;
  }

  if (response.status === 404) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throw new StreamingUnsupportedError();
  }
  if (!response.ok || !response.body) {
    // Clear the timer/listener before reading the error body so a hung .json()
    // can't leave the timer armed and fire a stray abort.
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    const body = await response.json().catch(() => ({}));
    throwBackendError(body, response.status);
  }

  const label = "Transcription backend upload stream";
  try {
    return await consumeTranscriptionNdjson(
      response.body as ReadableStream<Uint8Array>, options?.onProgress, options?.onPhase, controller.signal, externalSignal, label, timeoutMs);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw abortReasonError(externalSignal, label, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
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

  const timeoutMs = resolveTranscribeTimeoutMs(options?.timeoutSeconds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(`${url}/transcribe/url/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (error instanceof Error && error.name === "AbortError") {
      throw abortReasonError(externalSignal, "Transcription backend URL stream", timeoutMs);
    }
    throw error;
  }

  if (response.status === 404) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throw new StreamingUnsupportedError();
  }
  if (!response.ok || !response.body) {
    // Clear the timer/listener before reading the error body so a hung .json()
    // can't leave the timer armed and fire a stray abort.
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    const errBody = await response.json().catch(() => ({}));
    throwBackendError(errBody, response.status);
  }

  const label = "Transcription backend URL stream";
  try {
    return await consumeTranscriptionNdjson(
      response.body as ReadableStream<Uint8Array>, options?.onProgress, options?.onPhase, controller.signal, externalSignal, label, timeoutMs);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw abortReasonError(externalSignal, label, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
