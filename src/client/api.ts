import type { FolderNode, JobPreview, JobRow, LlmHealth, LogEntry, QueueStatus, ScanResult, Task, TranscribeRequest, TranscribeResponse, TranscriptionHealth, TranscriptionHistoryEntry, TranscriptionPreflightResponse } from "./types";

const BASE = "/api";

type JsonErrorBody = { error?: unknown; message?: unknown };

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function fetchJSON<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  if (opts.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${BASE}${url}`, {
    ...opts,
    headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as JsonErrorBody;
    const message = typeof body.error === "string"
      ? body.error
      : typeof body.message === "string"
        ? body.message
        : `HTTP ${res.status}`;
    throw new ApiError(message, res.status, url);
  }
  return res.json() as Promise<T>;
}

// Request options threaded through query hooks. Carries React Query's
// AbortSignal so in-flight requests can be cancelled on unmount/refetch.
type FetchOpts = { signal?: AbortSignal };

// Settings
export const getSettings = (opts?: FetchOpts) => fetchJSON<Record<string, unknown>>("/settings", opts);
export const saveSettings = (settings: Record<string, unknown>, opts?: FetchOpts) =>
  fetchJSON("/settings", { ...opts, method: "POST", body: JSON.stringify(settings) });

// Tasks
export const getTasks = (opts?: FetchOpts) => fetchJSON<Task[]>("/tasks", opts);
export const createTask = (payload: Partial<Task>) =>
  fetchJSON<Task>("/tasks", { method: "POST", body: JSON.stringify(payload) });
export const updateTask = (id: number, payload: Partial<Task>) =>
  fetchJSON<Task>(`/tasks/${id}`, { method: "PUT", body: JSON.stringify(payload) });
export const deleteTask = (id: number) =>
  fetchJSON(`/tasks/${id}`, { method: "DELETE" });

// Scanner
export const scanFolder = () => fetchJSON<ScanResult>("/scan", { method: "POST" });
export const previewScan = (opts?: FetchOpts) => fetchJSON<ScanResult>("/scan/preview", opts);
export const getSubfolders = (opts?: FetchOpts) => fetchJSON<{ subfolders: string[] }>("/subfolders", opts);
export const getFolderTree = (opts?: FetchOpts) => fetchJSON<{ root: FolderNode }>("/folders/tree", opts);

// Jobs
export const getJobs = (opts?: FetchOpts) =>
  fetchJSON<{ jobs: JobRow[]; queueRunning: boolean; currentJobId: number | null }>("/jobs", opts);
export const retryJob = (id: number) =>
  fetchJSON(`/jobs/${id}/retry`, { method: "POST" });
export const forceJob = (id: number) =>
  fetchJSON(`/jobs/${id}/force`, { method: "POST" });
export const retryJobsApi = (ids: number[]) =>
  fetchJSON<{ ok: boolean; updated: number }>("/jobs/retry-selected", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
export const forceJobsApi = (ids: number[]) =>
  fetchJSON<{ ok: boolean; updated: number }>("/jobs/force-selected", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
export const deleteJobApi = (id: number) =>
  fetchJSON(`/jobs/${id}`, { method: "DELETE" });
export const deleteJobsApi = (ids: number[]) =>
  fetchJSON<{ ok: boolean; deleted: number }>("/jobs/delete-selected", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
export const clearJobs = () =>
  fetchJSON("/jobs/clear", { method: "POST" });
export const pinJob = (id: number) =>
  fetchJSON(`/jobs/${id}/pin`, { method: "POST" });
export const unpinJob = (id: number) =>
  fetchJSON(`/jobs/${id}/unpin`, { method: "POST" });
export const getJobPreview = (id: number, opts?: FetchOpts) => fetchJSON<JobPreview>(`/jobs/${id}/preview`, opts);

// Manual cue edits — saves edited translated lines to the OUTPUT file.
export interface CueEditInput {
  index: number;
  text: string;
}
export const saveJobCues = (id: number, edits: CueEditInput[], opts?: FetchOpts) =>
  fetchJSON<{ ok: boolean; updated: number }>(`/jobs/${id}/cues`, {
    ...opts,
    method: "PUT",
    body: JSON.stringify({ edits }),
  });
// URL for an <a href download> that streams the translated output file.
export const jobDownloadUrl = (id: number) => `${BASE}/jobs/${id}/download`;

// Queue
export const startQueue = (ids?: number[]) =>
  fetchJSON("/queue/start", {
    method: "POST",
    body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
  });
export const stopQueue = () => fetchJSON("/queue/stop", { method: "POST" });
export const getQueueStatus = (opts?: FetchOpts) => fetchJSON<QueueStatus>("/queue/status", opts);

// Watcher
export const startWatcher = () => fetchJSON("/watcher/start", { method: "POST" });
export const stopWatcher = () => fetchJSON("/watcher/stop", { method: "POST" });

// Logs
export const getLogs = (params?: {
  level?: string;
  category?: string;
  jobId?: number;
  limit?: number;
  offset?: number;
}, opts?: FetchOpts) => {
  const q = new URLSearchParams();
  if (params?.level) q.set("level", params.level);
  if (params?.category) q.set("category", params.category);
  if (typeof params?.jobId === "number") q.set("job_id", String(params.jobId));
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.offset) q.set("offset", String(params.offset));
  return fetchJSON<LogEntry[]>(`/logs?${q.toString()}`, opts);
};
export const clearLogsApi = () => fetchJSON("/logs", { method: "DELETE" });

// Connection test — no payload tests the active connection; a payload tests
// the supplied (possibly unsaved) connection fields.
export const testConnection = (payload?: { provider?: string; apiKey?: string; model?: string; endpoint?: string }) =>
  fetchJSON<{ ok: boolean; message: string }>("/test-connection", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });

export const getLlmHealth = (opts?: FetchOpts) =>
  fetchJSON<LlmHealth>("/llm-health", opts);

// Outbound notification webhook test — sends a sample notification using the
// currently-saved settings and reports whether the webhook accepted it.
export const testNotification = () =>
  fetchJSON<{ ok: boolean; error?: string }>("/notify/test", { method: "POST" });

// Subtitle format converter
export type ConvertTargetFormat = "srt" | "vtt" | "ass" | "ssa";
export interface ConvertRequest {
  files: { name: string; content: string }[];
  targetFormat: ConvertTargetFormat;
}
export interface ConvertResponse {
  files: { name: string; content: string }[];
  errors: { name: string; error: string }[];
}
export const convertSubtitles = (body: ConvertRequest, opts?: FetchOpts) =>
  fetchJSON<ConvertResponse>("/convert", { ...opts, method: "POST", body: JSON.stringify(body) });

// Speech-to-text
export const getTranscriptionHealth = (opts?: FetchOpts) =>
  fetchJSON<TranscriptionHealth>("/transcribe/health", opts);
export const preflightTranscription = (payload: TranscribeRequest) =>
  fetchJSON<TranscriptionPreflightResponse>("/transcribe/preflight", { method: "POST", body: JSON.stringify(payload) });
export const transcribeVideo = (payload: TranscribeRequest) =>
  fetchJSON<TranscribeResponse>("/transcribe", { method: "POST", body: JSON.stringify(payload) });
export const getTranscriptionHistory = (limit = 10, opts?: FetchOpts) =>
  fetchJSON<{ attempts: TranscriptionHistoryEntry[] }>(`/transcribe/history?limit=${limit}`, opts);
export const retryTranscriptionAttempt = (id: string) =>
  fetchJSON<TranscribeResponse>(`/transcribe/history/${id}/retry`, { method: "POST" });
export const cancelTranscription = (payload: { path: string }) =>
  fetchJSON<{ ok: boolean }>("/transcribe/cancel", { method: "POST", body: JSON.stringify(payload) });
