// Shared low-level helpers for the Whisper backend HTTP client: timeout
// wrapping, auth headers, error mapping, timeout resolution, NDJSON line
// parsing, and the streaming-unsupported sentinel. Used by every transport
// (path/shared-FS, upload, URL) and by the model-manager client.

import type {
  BackendTranscriptionResponse,
  TranscribeStreamingOptions,
  TranscriptionProgressUpdate,
} from "./types.js";

// Short timeout (ms) for lightweight backend calls (health, preflight).
export const SHORT_REQUEST_TIMEOUT_MS = 10_000;
// Default timeout (ms) for /transcribe when no setting is supplied (30 minutes).
// Streamed runs use it as an idle timeout: every backend line resets it.
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 1_800_000;
// Once a streamed run reports its media length, it may take at most the
// timeout plus this many times that length, however steadily it reports
// progress: a slow CPU run gets room, a wedged loop still ends.
export const CEILING_REALTIME_FACTOR = 10;

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
  const externalSignal = init.signal ?? undefined;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
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
        return `Model "${d.model}" is not downloaded — download it in Settings → Speech-to-text → Speech-to-text models first`;
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

/**
 * Deadline for a streamed run. The idle timer restarts on every line the
 * backend sends, so a long CPU run that keeps reporting progress is never cut
 * off at a fixed total. The first progress line that carries the media length
 * adds a ceiling measured from the start of the run.
 */
class StreamDeadline {
  readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  private expired: { ms: number; idle: boolean } | null = null;
  private readonly onExternalAbort = () => this.controller.abort();

  constructor(
    private readonly idleMs: number,
    private readonly label: string,
    private readonly externalSignal: AbortSignal | undefined,
  ) {
    if (externalSignal?.aborted) this.controller.abort();
    else externalSignal?.addEventListener("abort", this.onExternalAbort, { once: true });
    this.touch();
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.expire(this.idleMs, true), this.idleMs);
  }

  noteMediaSeconds(totalSeconds: number): void {
    if (this.ceilingTimer || !(totalSeconds > 0)) return;
    const ceilingMs = this.idleMs + Math.round(totalSeconds * 1000 * CEILING_REALTIME_FACTOR);
    const remaining = Math.max(0, ceilingMs - (Date.now() - this.startedAt));
    this.ceilingTimer = setTimeout(() => this.expire(ceilingMs, false), remaining);
  }

  error(): Error {
    if (this.externalSignal?.aborted || !this.expired) return abortReasonError(this.externalSignal, this.label, this.idleMs);
    const seconds = Math.round(this.expired.ms / 1000);
    return new Error(`${this.label} timed out after ${seconds}s${this.expired.idle ? " without progress" : ""}`);
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.ceilingTimer) clearTimeout(this.ceilingTimer);
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort);
  }

  private expire(ms: number, idle: boolean): void {
    this.expired ??= { ms, idle };
    this.controller.abort();
  }
}

// Reads the NDJSON progress protocol. Progress lines drive onProgress, the
// terminal "result" line is returned, an "error" line throws. Every line
// restarts the idle deadline.
async function consumeTranscriptionNdjson(
  body: ReadableStream<Uint8Array>,
  deadline: StreamDeadline,
  options: TranscribeStreamingOptions | undefined,
): Promise<BackendTranscriptionResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let result: BackendTranscriptionResponse | null = null;
  let streamError: string | null = null;

  const handleLine = (line: string): void => {
    const record = parseNdjsonLine(line);
    if (!record) return;
    deadline.touch();
    const type = record.type;
    if (type === "progress") {
      const update = toProgressUpdate(record);
      if (update) {
        deadline.noteMediaSeconds(update.totalSeconds);
        options?.onProgress?.(update);
      }
    } else if (type === "phase") {
      if (typeof record.phase === "string") options?.onPhase?.(record.phase);
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
    if (deadline.controller.signal.aborted) throw deadline.error();
    throw error;
  }

  if (streamError) {
    const err = new Error(streamError);
    (err as Error & { backendStatus?: number }).backendStatus = 500;
    throw err;
  }
  if (!result) {
    // A stream that ended as the deadline fired reports the abort, not a
    // confusing "ended without result".
    if (deadline.controller.signal.aborted) throw deadline.error();
    throw new Error("Transcription stream ended without a result");
  }
  return result;
}

/**
 * POSTs to a streaming transcribe route and consumes its NDJSON progress
 * protocol under an idle deadline (see StreamDeadline). A 404 (older backend
 * without the route) throws StreamingUnsupportedError so callers can fall back
 * to the JSON endpoint. Aborting options.signal closes the stream, which the
 * backend takes as a cancel.
 */
export async function postTranscriptionStream(
  url: string,
  init: { headers: Record<string, string>; body: BodyInit },
  label: string,
  options?: TranscribeStreamingOptions,
): Promise<BackendTranscriptionResponse> {
  const deadline = new StreamDeadline(resolveTranscribeTimeoutMs(options?.timeoutSeconds), label, options?.signal);
  try {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", ...init, signal: deadline.controller.signal });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") throw deadline.error();
      throw error;
    }
    if (response.status === 404) throw new StreamingUnsupportedError();
    if (!response.ok || !response.body) {
      // Stop the deadline before reading the error body so a hung .json()
      // cannot fire a stray abort.
      deadline.dispose();
      const body = await response.json().catch(() => ({}));
      throwBackendError(body, response.status);
    }
    return await consumeTranscriptionNdjson(response.body as ReadableStream<Uint8Array>, deadline, options);
  } finally {
    deadline.dispose();
  }
}
