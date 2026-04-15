import type {
  FolderNode,
  JobPreview,
  JobRow,
  LogEntry,
  QueueStatus,
  ScanResult,
  Task,
  TranscriptionJob,
  WhisperHealth,
  WhisperModelsResponse,
} from "./types";

const BASE = "/api";

async function fetchJSON<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Settings
export const getSettings = () => fetchJSON<Record<string, unknown>>("/settings");
export const saveSettings = (settings: Record<string, unknown>) =>
  fetchJSON("/settings", { method: "POST", body: JSON.stringify(settings) });

// Tasks
export const getTasks = () => fetchJSON<Task[]>("/tasks");
export const createTask = (payload: Partial<Task>) =>
  fetchJSON<Task>("/tasks", { method: "POST", body: JSON.stringify(payload) });
export const updateTask = (id: number, payload: Partial<Task>) =>
  fetchJSON<Task>(`/tasks/${id}`, { method: "PUT", body: JSON.stringify(payload) });
export const deleteTask = (id: number) =>
  fetchJSON(`/tasks/${id}`, { method: "DELETE" });

// Scanner
export const scanFolder = () => fetchJSON<ScanResult>("/scan", { method: "POST" });
export const previewScan = () => fetchJSON<ScanResult>("/scan/preview");
export const getSubfolders = () => fetchJSON<{ subfolders: string[] }>("/subfolders");
export const getFolderTree = () => fetchJSON<{ root: FolderNode }>("/folders/tree");

// Jobs
export const getJobs = () =>
  fetchJSON<{ jobs: JobRow[]; queueRunning: boolean; currentJobId: number | null }>("/jobs");
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
export const getJobPreview = (id: number) => fetchJSON<JobPreview>(`/jobs/${id}/preview`);

// Queue
export const startQueue = (ids?: number[]) =>
  fetchJSON("/queue/start", {
    method: "POST",
    body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
  });
export const stopQueue = () => fetchJSON("/queue/stop", { method: "POST" });
export const getQueueStatus = () => fetchJSON<QueueStatus>("/queue/status");

// Watcher
export const startWatcher = () => fetchJSON("/watcher/start", { method: "POST" });
export const stopWatcher = () => fetchJSON("/watcher/stop", { method: "POST" });

// Logs
export const getLogs = (params?: {
  level?: string;
  category?: string;
  limit?: number;
  offset?: number;
}) => {
  const q = new URLSearchParams();
  if (params?.level) q.set("level", params.level);
  if (params?.category) q.set("category", params.category);
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.offset) q.set("offset", String(params.offset));
  return fetchJSON<LogEntry[]>(`/logs?${q.toString()}`);
};
export const clearLogsApi = () => fetchJSON("/logs", { method: "DELETE" });

// Connection test
export const testConnection = () =>
  fetchJSON<{ ok: boolean; message: string }>("/test-connection", { method: "POST" });

// --- Transcription ---
export const transcribeVideo = (videoPath: string) =>
  fetchJSON<{ ok: boolean; jobs: TranscriptionJob[] }>("/transcribe", {
    method: "POST",
    body: JSON.stringify({ video_path: videoPath }),
  });
export const transcribeVideos = (videoPaths: string[]) =>
  fetchJSON<{ ok: boolean; jobs: TranscriptionJob[] }>("/transcribe", {
    method: "POST",
    body: JSON.stringify({ video_paths: videoPaths }),
  });
export const listTranscriptionJobs = (filter?: { kind?: string; status?: string }) => {
  const q = new URLSearchParams();
  if (filter?.kind) q.set("kind", filter.kind);
  if (filter?.status) q.set("status", filter.status);
  return fetchJSON<{ jobs: TranscriptionJob[] }>(`/transcription/jobs?${q.toString()}`);
};
export const cancelTranscription = (id: number) =>
  fetchJSON(`/transcription/jobs/${id}/cancel`, { method: "POST" });
export const retryTranscription = (id: number) =>
  fetchJSON<{ ok: boolean; job: TranscriptionJob }>(`/transcription/jobs/${id}/retry`, {
    method: "POST",
  });
export const deleteTranscription = (id: number) =>
  fetchJSON(`/transcription/jobs/${id}`, { method: "DELETE" });
export const testWhisperConnection = () =>
  fetchJSON<{ ok: boolean; health?: WhisperHealth; error?: string }>("/transcription/test", {
    method: "POST",
  });
export const listWhisperModels = () =>
  fetchJSON<WhisperModelsResponse>("/transcription/models");
export const downloadWhisperModel = (kind: "whisper" | "uvr", name: string) =>
  fetchJSON<{ ok: boolean; job: TranscriptionJob }>("/transcription/models/download", {
    method: "POST",
    body: JSON.stringify({ kind, name }),
  });
export const deleteWhisperModel = (kind: "whisper" | "uvr", name: string) => {
  const encoded = name.split("/").map(encodeURIComponent).join("/");
  return fetchJSON(`/transcription/models/${kind}/${encoded}`, { method: "DELETE" });
};
export const rotateWhisperKey = () =>
  fetchJSON<{ ok: boolean; apiKey: string }>("/transcription/rotate-key", { method: "POST" });
