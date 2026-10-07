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
  fetchWithTimeout,
  normalizeTranscriptionBackendUrl,
  postTranscriptionStream,
  resolveTranscribeTimeoutMs,
  throwBackendError,
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
  const response = await fetchWithTimeout(
    `${url}/transcribe`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
      body: JSON.stringify(request),
      signal: options?.signal,
    },
    timeoutMs,
    "Transcription backend",
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as BackendTranscriptionResponse;
}

/**
 * POSTs to /transcribe/stream and consumes the NDJSON line protocol under an
 * idle timeout (see postTranscriptionStream). A 404 (older backend without the
 * stream route) throws StreamingUnsupportedError so the caller can fall back
 * to transcribeWithBackend. The passed AbortSignal cancels the request.
 */
export async function transcribeWithBackendStreaming(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  options?: TranscribeStreamingOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  return postTranscriptionStream(
    `${url}/transcribe/stream`,
    {
      headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
      body: JSON.stringify(request),
    },
    "Transcription backend stream",
    options,
  );
}
