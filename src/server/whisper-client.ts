/**
 * HTTP client for the subsmelt-whisper backend.
 *
 * All methods read the endpoint + API key from the subsmelt settings store so
 * admins can change them via the UI without restarting the server.
 */

import { getSetting } from "./config.js";

export interface WhisperVadOptions {
  enabled: boolean;
  min_silence_ms?: number;
  speech_pad_ms?: number;
  threshold?: number;
}

export interface WhisperUvrOptions {
  enabled: boolean;
  model_name?: string;
}

export interface WhisperTranscribeRequest {
  video_path: string;
  output_path: string;
  model: string;
  language?: string | null;
  task: "transcribe" | "translate";
  output_format: "srt" | "vtt" | "txt";
  beam_size?: number;
  temperature?: number;
  initial_prompt?: string | null;
  vad: WhisperVadOptions;
  uvr: WhisperUvrOptions;
}

export interface WhisperTaskResponse {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  stage: string | null;
  progress: number;
  error: string | null;
  video_path: string | null;
  output_path: string | null;
  output_format: string | null;
  model_kind: string | null;
  model_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface WhisperHealth {
  ok: boolean;
  auth_required: boolean;
  device: string;
  compute_type: string;
  max_concurrent: number;
  media_dir: string;
  models_dir: string;
  gpu_name: string | null;
  cuda_available: boolean;
  vram_free_bytes: number | null;
}

export interface WhisperModelEntry {
  name: string;
  path?: string;
  size_bytes?: number;
  repo_id?: string;
  size_hint?: string;
  description?: string;
}

export interface WhisperModelsResponse {
  whisper: { cached: WhisperModelEntry[]; catalog: WhisperModelEntry[] };
  uvr: { cached: WhisperModelEntry[]; catalog: WhisperModelEntry[] };
}

export class WhisperClientError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "WhisperClientError";
  }
}

function getEndpoint(override?: string): string {
  const raw = (override || getSetting("whisper_endpoint") || "http://localhost:9000").trim();
  return raw.replace(/\/+$/, "");
}

function getHeaders(override?: { apiKey?: string }): Record<string, string> {
  const apiKey = (override?.apiKey ?? getSetting("whisper_api_key") ?? "").trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function request<T>(
  method: string,
  path: string,
  opts?: {
    body?: unknown;
    endpoint?: string;
    apiKey?: string;
    timeoutMs?: number;
  }
): Promise<T> {
  const endpoint = getEndpoint(opts?.endpoint);
  const url = `${endpoint}${path}`;
  const controller = new AbortController();
  const timeout = opts?.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: getHeaders({ apiKey: opts?.apiKey }),
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json() as { detail?: string; error?: string };
        detail = body.detail || body.error || detail;
      } catch {
        /* ignore */
      }
      throw new WhisperClientError(detail, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (e: unknown) {
    if (e instanceof WhisperClientError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new WhisperClientError(msg);
  } finally {
    clearTimeout(timer);
  }
}

export const whisperClient = {
  health(override?: { endpoint?: string; apiKey?: string }) {
    return request<WhisperHealth>("GET", "/health", { ...override, timeoutMs: 10_000 });
  },

  submitTranscribe(payload: WhisperTranscribeRequest) {
    return request<{ task_id: string }>("POST", "/transcribe", { body: payload });
  },

  getTask(taskId: string) {
    return request<WhisperTaskResponse>("GET", `/tasks/${encodeURIComponent(taskId)}`, {
      timeoutMs: 10_000,
    });
  },

  cancelTask(taskId: string) {
    return request<{ ok: boolean; status: string }>(
      "DELETE",
      `/tasks/${encodeURIComponent(taskId)}`
    );
  },

  listModels() {
    return request<WhisperModelsResponse>("GET", "/models", { timeoutMs: 10_000 });
  },

  downloadModel(kind: "whisper" | "uvr", name: string) {
    return request<{ task_id: string }>("POST", "/models/download", {
      body: { kind, name },
    });
  },

  deleteModel(kind: "whisper" | "uvr", name: string) {
    const encoded = name.split("/").map(encodeURIComponent).join("/");
    return request<{ ok: boolean }>("DELETE", `/models/${kind}/${encoded}`);
  },

  rotateApiKey() {
    return request<{ ok: boolean; api_key: string }>("POST", "/admin/api-key/rotate");
  },
};
