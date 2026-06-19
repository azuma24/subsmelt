import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  BackendPreflightResponse,
  BackendTranscriptionRequest,
  BackendTranscriptionResponse,
  DownloadBackendModelOptions,
  LowRamBehavior,
  TranscribeBackendOptions,
  TranscribeStreamingOptions,
  TranscriptionProgressUpdate,
  TranscriptionSettings,
  WhisperModelDeleteResult,
  WhisperModelDownloadProgress,
  WhisperModelDownloadResult,
  WhisperModelInfo,
} from "./types.js";

// Short timeout (ms) for lightweight backend calls (health, preflight).
const SHORT_REQUEST_TIMEOUT_MS = 10_000;
// Hard cap on upload-transport file size (5 GB). Larger files must use shared-FS
// transport; uploading them risks exhausting memory/disk on either end.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
// Default timeout (ms) for /transcribe when no setting is supplied (30 minutes).
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 1_800_000;

/**
 * Runs fetch with an AbortController-based timeout. On timeout, throws a clear
 * "<label> timed out after Ns" error instead of hanging Node forever.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Distinguishes an external cancel from an internal timeout when our
// AbortController fires. If the caller's signal aborted, it's a real
// cancellation; otherwise the timeout timer fired, so report a timeout error
// matching fetchWithTimeout's "<label> timed out after Ns" wording.
function abortReasonError(externalSignal: AbortSignal | undefined, label: string, timeoutMs: number): Error {
  if (externalSignal?.aborted) return new Error("Transcription cancelled");
  return new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

function lowRamBehavior(raw: string | undefined): LowRamBehavior {
  return raw === "downgrade" || raw === "skip" || raw === "run_anyway" ? raw : "ask";
}

export function normalizeTranscriptionBackendUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// Phase 1 remote hardening: when a shared-secret token is configured it is sent
// as `Authorization: Bearer <token>` on every backend call. An empty/whitespace
// token means no header (localhost dev default), matching the backend which
// disables auth when SUBSMELT_WHISPER_TOKEN is unset.
export function transcriptionAuthHeaders(token: string | undefined): Record<string, string> {
  const value = typeof token === "string" ? token.trim() : "";
  return value ? { Authorization: `Bearer ${value}` } : {};
}

// Clear, actionable message when the backend rejects the configured token so the
// user is pointed straight at the setting to fix.
const TOKEN_REJECTED_MESSAGE =
  "Whisper backend rejected the token — check Transcription backend token in Settings";

// Throws the standard 401 message; otherwise returns the generic backend error.
// Centralizes 401 handling so every backend call surfaces the same guidance.
function throwBackendError(body: unknown, status: number): never {
  const err = status === 401 ? new Error(TOKEN_REJECTED_MESSAGE) : new Error(backendErrorMessage(body, status));
  // Carry the backend HTTP status so callers can map a 5xx upstream failure to a
  // 502 (instead of relying on message-text heuristics that drop the status).
  (err as Error & { backendStatus?: number }).backendStatus = status;
  throw err;
}

function backendErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const detail = record.detail;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      const d = detail as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
      // Some backend errors carry a structured code but no message (e.g. the
      // 409 model_not_downloaded shape {code, model}). Render an actionable line
      // instead of falling through to the useless "HTTP <status>" generic.
      if (d.code === "model_not_downloaded" && typeof d.model === "string") {
        return `Model "${d.model}" is not downloaded — download it in Settings → Speech to Text → Whisper Models first`;
      }
      if (typeof d.code === "string") return `Transcription failed (${d.code})`;
    }
  }
  return `Transcription backend returned HTTP ${status}`;
}

export async function fetchTranscriptionHealth(backendUrl: string, model?: string, token?: string): Promise<unknown> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const qs = model ? `?${new URLSearchParams({ model }).toString()}` : "";
  const response = await fetchWithTimeout(`${url}/health${qs}`, {
    headers: { ...transcriptionAuthHeaders(token) },
  }, SHORT_REQUEST_TIMEOUT_MS, "Transcription backend health check");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body;
}

export async function preflightTranscription(backendUrl: string, request: BackendTranscriptionRequest, token?: string): Promise<BackendPreflightResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetchWithTimeout(`${url}/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(token) },
    body: JSON.stringify(request),
  }, SHORT_REQUEST_TIMEOUT_MS, "Transcription backend preflight");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as BackendPreflightResponse;
}

export async function applyPreflightPolicy(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  settings: TranscriptionSettings,
): Promise<BackendTranscriptionRequest> {
  const token = settings.transcription_backend_token;
  const preflight = await preflightTranscription(backendUrl, request, token);
  if (preflight.safe !== false && preflight.ok !== false) return request;

  if (preflight.code === "insufficient_ram") {
    const behavior = lowRamBehavior(settings.transcription_low_ram_behavior);
    if (behavior === "downgrade" && preflight.suggestedModel && preflight.suggestedModel !== request.model) {
      const downgraded = { ...request, model: preflight.suggestedModel };
      const downgradedPreflight = await preflightTranscription(backendUrl, downgraded, token);
      if (downgradedPreflight.safe !== false && downgradedPreflight.ok !== false) return downgraded;
    }
    if (behavior === "run_anyway") return { ...request, allow_unsafe: true };
    if (behavior === "skip") {
      throw new Error(`Transcription skipped: insufficient RAM (${preflight.availableRamMb ?? "unknown"} MB available, ${preflight.requiredRamMb ?? "unknown"} MB required)`);
    }
    throw new Error(`Not enough RAM for ${request.model}; available ${preflight.availableRamMb ?? "unknown"} MB, required ${preflight.requiredRamMb ?? "unknown"} MB`);
  }

  if (preflight.code === "insufficient_disk") {
    throw new Error(`Not enough disk space for transcription; available ${preflight.diskAvailableMb ?? "unknown"} MB, required ${preflight.requiredDiskMb ?? "unknown"} MB`);
  }

  throw new Error(`Transcription preflight failed: ${preflight.code || "unsafe"}`);
}

function resolveTranscribeTimeoutMs(timeoutSeconds: number | undefined): number {
  if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return Math.round(timeoutSeconds * 1000);
  }
  return DEFAULT_TRANSCRIBE_TIMEOUT_MS;
}

export async function transcribeWithBackend(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  options?: TranscribeBackendOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const timeoutMs = resolveTranscribeTimeoutMs(options?.timeoutSeconds);
  const response = await fetchWithTimeout(`${url}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
    body: JSON.stringify(request),
  }, timeoutMs, "Transcription backend");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as BackendTranscriptionResponse;
}

// Sentinel thrown when the stream endpoint is absent (older backend) so callers
// can transparently fall back to the non-streaming JSON endpoint.
export class StreamingUnsupportedError extends Error {
  constructor(message = "Streaming transcription endpoint is unavailable") {
    super(message);
    this.name = "StreamingUnsupportedError";
  }
}

function parseNdjsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toProgressUpdate(record: Record<string, unknown>): TranscriptionProgressUpdate | null {
  const pct = typeof record.pct === "number" ? record.pct : undefined;
  const processedSeconds = typeof record.processedSeconds === "number" ? record.processedSeconds : undefined;
  const totalSeconds = typeof record.totalSeconds === "number" ? record.totalSeconds : undefined;
  if (pct === undefined || processedSeconds === undefined || totalSeconds === undefined) return null;
  return { pct, processedSeconds, totalSeconds };
}

/**
 * POSTs to /transcribe/stream and consumes the NDJSON line protocol. Progress
 * lines invoke onProgress; the terminal "result" line resolves the promise; an
 * "error" line throws. If the endpoint returns 404 (older backend without the
 * stream route) a StreamingUnsupportedError is thrown so the caller can fall
 * back to transcribeWithBackend. The passed AbortSignal cancels the request.
 */
export async function transcribeWithBackendStreaming(
  backendUrl: string,
  request: BackendTranscriptionRequest,
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
    response = await fetch(`${url}/transcribe/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (error instanceof Error && error.name === "AbortError") {
      throw abortReasonError(externalSignal, "Transcription backend stream", timeoutMs);
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
      if (update && options?.onProgress) options.onProgress(update);
    } else if (type === "phase") {
      if (typeof record.phase === "string" && options?.onPhase) options.onPhase(record.phase);
    } else if (type === "result") {
      const { type: _t, ...rest } = record;
      result = rest as unknown as BackendTranscriptionResponse;
    } else if (type === "error") {
      streamError = typeof record.error === "string" ? record.error : "Transcription failed";
    }
  };

  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
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
    if (error instanceof Error && error.name === "AbortError") {
      throw abortReasonError(externalSignal, "Transcription backend stream", timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }

  if (streamError) {
    const err = new Error(streamError);
    (err as Error & { backendStatus?: number }).backendStatus = 500;
    throw err;
  }
  if (!result) throw new Error("Transcription stream ended without a result");
  return result;
}

// ======== Upload transport (Model B, plan Phase 2) ========
// The media bytes are uploaded as multipart instead of pointing the backend at a
// shared path; the backend returns subtitle CONTENT which the caller writes
// locally. `openAsBlob` reads the file from disk; note undici may still buffer
// parts of the multipart body in memory, so large files are capped below.

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

// ======== Whisper Model Manager ========
// Thin client over the backend model-manager API. Reuses the same auth-header
// pattern + abortable fetch as the transcription calls. The browser never hits
// the whisper backend directly — these are invoked from the SubSmelt server
// proxy routes (GET /api/whisper/models, POST .../download, DELETE .../:model).

// GET {backend}/models → { models: [...] }
export async function listBackendModels(backendUrl: string, token?: string): Promise<WhisperModelInfo[]> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetchWithTimeout(`${url}/models`, {
    headers: { ...transcriptionAuthHeaders(token) },
  }, SHORT_REQUEST_TIMEOUT_MS, "Whisper model list");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  const models = (body as { models?: unknown })?.models;
  return Array.isArray(models) ? (models as WhisperModelInfo[]) : [];
}

// DELETE {backend}/models/{model} → { ok, freedMb }
export async function deleteBackendModel(backendUrl: string, model: string, token?: string): Promise<WhisperModelDeleteResult> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetchWithTimeout(`${url}/models/${encodeURIComponent(model)}`, {
    method: "DELETE",
    headers: { ...transcriptionAuthHeaders(token) },
  }, SHORT_REQUEST_TIMEOUT_MS, "Whisper model delete");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as WhisperModelDeleteResult;
}

// Downloads model size can vary; large models take a while, so the download
// stream gets the same generous default as a transcription run.
const DEFAULT_DOWNLOAD_TIMEOUT_MS = DEFAULT_TRANSCRIBE_TIMEOUT_MS;

function toDownloadProgress(record: Record<string, unknown>): WhisperModelDownloadProgress | null {
  const pct = typeof record.pct === "number" ? record.pct : undefined;
  if (pct === undefined) return null;
  return {
    pct,
    ...(typeof record.downloadedMb === "number" ? { downloadedMb: record.downloadedMb } : {}),
    ...(typeof record.totalMb === "number" ? { totalMb: record.totalMb } : {}),
  };
}

// POST {backend}/models/download body {model} → NDJSON stream:
//   {type:"progress",pct,downloadedMb,totalMb} … terminal
//   {type:"result",ok,model,cachePath} or {type:"error",error}
// Consumes the stream line-by-line, invoking onProgress per progress line and
// resolving with the terminal result. Reuses the transcription NDJSON parser.
export async function downloadBackendModel(
  backendUrl: string,
  model: string,
  options?: DownloadBackendModelOptions,
): Promise<WhisperModelDownloadResult> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");

  const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${url}/models/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Whisper model download timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  }

  if (!response.ok || !response.body) {
    // Clear the timer before reading the error body so a hung .json() can't leave
    // the timer armed and fire a stray abort.
    clearTimeout(timer);
    const body = await response.json().catch(() => ({}));
    throwBackendError(body, response.status);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: WhisperModelDownloadResult | null = null;
  let streamError: string | null = null;

  const handleLine = (line: string): void => {
    const record = parseNdjsonLine(line);
    if (!record) return;
    const type = record.type;
    if (type === "progress") {
      const update = toDownloadProgress(record);
      if (update && options?.onProgress) options.onProgress(update);
    } else if (type === "result") {
      result = {
        ok: record.ok !== false,
        model: typeof record.model === "string" ? record.model : model,
        ...(typeof record.cachePath === "string" ? { cachePath: record.cachePath } : {}),
      };
    } else if (type === "error") {
      streamError = typeof record.error === "string" ? record.error : "Model download failed";
    }
  };

  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
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
  } finally {
    clearTimeout(timer);
  }

  if (streamError) {
    const err = new Error(streamError);
    (err as Error & { backendStatus?: number }).backendStatus = 500;
    throw err;
  }
  if (!result) throw new Error("Model download stream ended without a result");
  return result;
}
