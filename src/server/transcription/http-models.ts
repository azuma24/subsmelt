// ======== Whisper Model Manager ========
// Thin client over the backend model-manager API. Reuses the same auth-header
// pattern + abortable fetch as the transcription calls. The browser never hits
// the whisper backend directly — these are invoked from the SubSmelt server
// proxy routes (GET /api/whisper/models, POST .../download, DELETE .../:model).

import type {
  DownloadBackendModelOptions,
  WhisperModelDeleteResult,
  WhisperModelDownloadOperation,
  WhisperModelDownloadProgress,
  WhisperModelDownloadResult,
  WhisperModelInfo,
} from "./types.js";
import {
  DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  fetchWithTimeout,
  normalizeTranscriptionBackendUrl,
  parseNdjsonLine,
  SHORT_REQUEST_TIMEOUT_MS,
  throwBackendError,
  transcriptionAuthHeaders,
} from "./http-shared.js";

// GET {backend}/models → { models: [...] }
export async function listBackendModels(backendUrl: string, token?: string): Promise<WhisperModelInfo[]> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetchWithTimeout(
    `${url}/models`,
    {
      headers: { ...transcriptionAuthHeaders(token) },
    },
    SHORT_REQUEST_TIMEOUT_MS,
    "Whisper model list",
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  const models = (body as { models?: unknown })?.models;
  return Array.isArray(models) ? (models as WhisperModelInfo[]) : [];
}

// DELETE {backend}/models/{model} → { ok, freedMb }
export async function deleteBackendModel(
  backendUrl: string,
  model: string,
  token?: string,
): Promise<WhisperModelDeleteResult> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetchWithTimeout(
    `${url}/models/${encodeURIComponent(model)}`,
    {
      method: "DELETE",
      headers: { ...transcriptionAuthHeaders(token) },
    },
    SHORT_REQUEST_TIMEOUT_MS,
    "Whisper model delete",
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as WhisperModelDeleteResult;
}

export async function requestBackendModelDownloadOperation(
  backendUrl: string,
  operationId: string,
  token: string | undefined,
  cancel: boolean,
): Promise<WhisperModelDownloadOperation> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetchWithTimeout(
    `${url}/models/download/${encodeURIComponent(operationId)}${cancel ? "/cancel" : ""}`,
    { method: cancel ? "POST" : "GET", headers: transcriptionAuthHeaders(token) },
    SHORT_REQUEST_TIMEOUT_MS,
    cancel ? "Cancel Whisper model download" : "Whisper model download status",
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as WhisperModelDownloadOperation;
}

export class ModelDownloadCancelledError extends Error {}

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
  let streamError: Error | null = null;

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
      const message = typeof record.error === "string" ? record.error : "Model download failed";
      streamError =
        record.code === "model_download_cancelled"
          ? new ModelDownloadCancelledError(message)
          : Object.assign(new Error(message), { backendStatus: 500 });
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

  if (streamError) throw streamError;
  if (!result) throw new Error("Model download stream ended without a result");
  return result;
}
