// Path/shared-filesystem transport (Model A): the backend reads the media file
// directly off a filesystem path it shares with the SubSmelt server (same host
// or a mounted Docker volume) and writes the subtitle back to a shared path.

import type {
  BackendTranscriptionRequest,
  BackendTranscriptionResponse,
  TranscribeBackendOptions,
  TranscribeStreamingOptions,
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
