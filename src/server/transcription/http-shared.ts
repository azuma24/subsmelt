// Shared low-level helpers for the Whisper backend HTTP client: timeout
// wrapping, auth headers, error mapping, timeout resolution, NDJSON line
// parsing, and the streaming-unsupported sentinel. Used by every transport
// (path/shared-FS, upload, URL) and by the model-manager client.

import type { TranscriptionProgressUpdate } from "./types.js";

// Short timeout (ms) for lightweight backend calls (health, preflight).
export const SHORT_REQUEST_TIMEOUT_MS = 10_000;
// Default timeout (ms) for /transcribe when no setting is supplied (30 minutes).
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 1_800_000;

/**
 * Runs fetch with an AbortController-based timeout. On timeout, throws a clear
 * "<label> timed out after Ns" error instead of hanging Node forever.
 */
export async function fetchWithTimeout(
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
export function abortReasonError(externalSignal: AbortSignal | undefined, label: string, timeoutMs: number): Error {
  if (externalSignal?.aborted) return new Error("Transcription cancelled");
  return new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
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
export function throwBackendError(body: unknown, status: number): never {
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

export function resolveTranscribeTimeoutMs(timeoutSeconds: number | undefined): number {
  if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return Math.round(timeoutSeconds * 1000);
  }
  return DEFAULT_TRANSCRIBE_TIMEOUT_MS;
}

// Sentinel thrown when the stream endpoint is absent (older backend) so callers
// can transparently fall back to the non-streaming JSON endpoint.
export class StreamingUnsupportedError extends Error {
  constructor(message = "Streaming transcription endpoint is unavailable") {
    super(message);
    this.name = "StreamingUnsupportedError";
  }
}

export function parseNdjsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function toProgressUpdate(record: Record<string, unknown>): TranscriptionProgressUpdate | null {
  const pct = typeof record.pct === "number" ? record.pct : undefined;
  const processedSeconds = typeof record.processedSeconds === "number" ? record.processedSeconds : undefined;
  const totalSeconds = typeof record.totalSeconds === "number" ? record.totalSeconds : undefined;
  if (pct === undefined || processedSeconds === undefined || totalSeconds === undefined) return null;
  return { pct, processedSeconds, totalSeconds };
}
