// Health/log/preflight calls to the Whisper backend: cheap, short-timeout
// requests used to check reachability and pre-run resource safety before
// committing to a (possibly long) transcription call.

import type {
  BackendPreflightResponse,
  BackendTranscriptionRequest,
  LowRamBehavior,
  TranscriptionSettings,
} from "./types.js";
import {
  fetchWithTimeout,
  normalizeTranscriptionBackendUrl,
  SHORT_REQUEST_TIMEOUT_MS,
  throwBackendError,
  transcriptionAuthHeaders,
} from "./http-shared.js";

function lowRamBehavior(raw: string | undefined): LowRamBehavior {
  return raw === "downgrade" || raw === "skip" || raw === "run_anyway" ? raw : "ask";
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

/** Tail the Whisper backend's own log file.
 *
 * The backend writes to a file on its host, which for a Windows service or the
 * GUI's console-less child process is otherwise unreachable — you had to be at
 * the machine to read it. Authenticated on the backend side (log lines carry
 * media paths), so the token is required like the other gated routes. */
export async function fetchTranscriptionLogs(
  backendUrl: string,
  lines: number,
  token?: string,
): Promise<unknown> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const qs = `?${new URLSearchParams({ lines: String(lines) }).toString()}`;
  const response = await fetchWithTimeout(`${url}/logs${qs}`, {
    headers: { ...transcriptionAuthHeaders(token) },
  }, SHORT_REQUEST_TIMEOUT_MS, "Transcription backend log fetch");
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
