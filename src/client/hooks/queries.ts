import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { useSsePollInterval } from "./sse";
import type {
  JobPreview,
  JobsResponse,
  LlmHealth,
  LlmStatus,
  LogEntry,
  QueueStatus,
  Task,
  TranscriptionHealth,
  TranscriptionHistoryEntry,
} from "../types";

export type { JobsResponse };

export function useSettingsQuery() {
  return useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => api.getSettings({ signal }), staleTime: 30_000 });
}

export function useTasksQuery() {
  return useQuery<Task[]>({ queryKey: ["tasks"], queryFn: ({ signal }) => api.getTasks({ signal }), staleTime: 10_000 });
}

/** Every video and subtitle under the media root with per-task status: the
 *  non-mutating scan preview. Library and Transcribe share this cache. */
export const LIBRARY_QUERY_KEY = ["library"] as const;

export function useLibraryQuery(enabled = true) {
  return useQuery({
    queryKey: LIBRARY_QUERY_KEY,
    queryFn: ({ signal }) => api.previewScan({ signal }),
    enabled,
    staleTime: 30_000,
  });
}


export function useJobsQuery() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: ({ signal }) => api.getJobs({ signal }),
    // SSE patches and invalidates ["jobs"] as events arrive (see sse.ts), so
    // while the stream is open this is a two-minute safety net; without it
    // the list polls every 30 s.
    refetchInterval: useSsePollInterval(30_000, 120_000),
  });
}

export function useLogsQuery(level?: string, category?: string, jobId?: number | null) {
  return useQuery<LogEntry[]>({
    queryKey: ["logs", level, category, jobId ?? null],
    queryFn: ({ signal }) => api.getLogs({ level: level || undefined, category: category || undefined, jobId: typeof jobId === "number" ? jobId : undefined, limit: 300 }, { signal }),
    // Logs are written (warn/error) WITHOUT a lifecycle SSE event during long
    // jobs, so this timer is the only way fresh diagnostics appear while tailing.
    // Keep it short (relaxed 3s → 8s, not 30s) so users don't miss warnings.
    refetchInterval: 8_000,
  });
}

export function useQueueStatusQuery() {
  return useQuery<QueueStatus>({
    queryKey: ["queue-status"],
    queryFn: ({ signal }) => api.getQueueStatus({ signal }),
    // SSE invalidates ["queue-status"] on every job progress and lifecycle
    // event, so while the stream is open this is a two-minute safety net.
    refetchInterval: useSsePollInterval(30_000, 120_000),
  });
}

export const LLM_STATUS_QUERY_KEY = ["llm-status"] as const;

/** Which LLM connection is busy or offline, for the sidebar status line. SSE
 *  job lifecycle events refetch it; the interval catches hosts going down. */
export function useLlmStatusQuery() {
  return useQuery<LlmStatus>({
    queryKey: LLM_STATUS_QUERY_KEY,
    queryFn: ({ signal }) => api.getLlmStatus({ signal }),
    // Job events refetch it; the interval is what notices a host going down,
    // so it keeps polling, just less often while the stream is open.
    refetchInterval: useSsePollInterval(30_000, 60_000),
  });
}

export function useLlmHealthQuery(enabled = true) {
  return useQuery<LlmHealth>({
    queryKey: ["llm-health"],
    queryFn: ({ signal }) => api.getLlmHealth({ signal }),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
}

/** Tail of the Whisper backend's own log file. Only polled while the Logs page
 *  is actually showing that source — it is a cross-host fetch, not local data. */
export function useTranscriptionLogsQuery(enabled: boolean, follow: boolean) {
  return useQuery<api.TranscriptionLogs>({
    queryKey: ["transcription-logs"],
    queryFn: ({ signal }) => api.getTranscriptionLogs(500, { signal }),
    enabled,
    refetchInterval: enabled && follow ? 5_000 : false,
  });
}

export function useTranscriptionHealthQuery(enabled = true) {
  return useQuery<TranscriptionHealth>({
    queryKey: ["transcription-health"],
    queryFn: ({ signal }) => api.getTranscriptionHealth({ signal }),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function useTranscriptionHistoryQuery(enabled = true, limit = 10) {
  return useQuery<{ attempts: TranscriptionHistoryEntry[] }>({
    queryKey: ["transcription-history", limit],
    queryFn: ({ signal }) => api.getTranscriptionHistory(limit, { signal }),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
  });
}

export function useJobPreview(jobId: number | null) {
  return useQuery<JobPreview>({
    queryKey: ["job-preview", jobId],
    queryFn: ({ signal }) => api.getJobPreview(jobId as number, { signal }),
    enabled: jobId !== null,
    // In-flight jobs write cues to a .part file; keep Preview live while open.
    refetchInterval: jobId !== null ? 4_000 : false,
  });
}

export function useYoutubePlaylistsQuery() {
  return useQuery({
    queryKey: ["youtube", "playlists"],
    queryFn: ({ signal }) => api.getYoutubePlaylists({ signal }),
    // SSE youtube:playlist refreshes this; the timer keeps "checked 6 min ago" honest.
    refetchInterval: useSsePollInterval(60_000, 180_000),
  });
}

export function useYoutubeVideosQuery(playlistId: string | null) {
  return useQuery({
    queryKey: ["youtube", "videos", playlistId],
    queryFn: ({ signal }) => api.getYoutubeVideos(playlistId as string, { signal }),
    enabled: Boolean(playlistId),
  });
}

export function useYoutubePipelineQuery() {
  return useQuery({
    queryKey: ["youtube", "pipeline"],
    queryFn: ({ signal }) => api.getYoutubePipeline({ signal }),
    // Job lifecycle events invalidate it too (see sse.ts), so the timer only
    // has to catch the GPU hold lifting; it polls slowly while the stream is open.
    refetchInterval: useSsePollInterval(10_000, 60_000),
  });
}

export function useYoutubeStatusQuery() {
  return useQuery({ queryKey: ["youtube", "status"], queryFn: ({ signal }) => api.getYoutubeStatus({ signal }), staleTime: 5_000 });
}

export function useYoutubeNotesFolderQuery(path: string) {
  return useQuery({
    queryKey: ["youtube", "notes-folder", path],
    queryFn: ({ signal }) => api.getYoutubeNotesFolder(path, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useWhisperModelsQuery(enabled = true) {
  return useQuery({
    queryKey: ["whisper-models"],
    queryFn: ({ signal }) => api.listWhisperModels({ signal }),
    enabled,
    staleTime: 15_000,
  });
}
