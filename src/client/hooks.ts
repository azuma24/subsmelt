import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type { JobPreview, Job, JobsResponse, LlmHealth, LlmStatus, LogEntry, QueueStatus, Task, TranscriptionHealth, TranscriptionHistoryEntry, YoutubeVideo } from "./types";

export type SSEEventName =
  | "job:progress"
  | "job:start"
  | "job:analysis"
  | "job:done"
  | "job:error"
  | "job:connection"
  | "job:cancelled"
  | "queue:finished"
  | "queue:stopped"
  | "scan:complete"
  | "job:stopped"
  | "transcription:progress"
  | "model:download"
  | "youtube:playlist"
  | "youtube:video"
  | "youtube:cooldown";

export type SSEEventHandler = (type: SSEEventName, data: Record<string, unknown>) => void;

export function useIsMobile() {
  // Guard for non-DOM environments (e.g. SSR/tests); the initializer already
  // captures the current match, so the effect only needs the change listener.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches
  );

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // No redundant setIsMobile(mql.matches) here — the useState initializer
    // already captured the initial value, so re-setting it forced an extra
    // render on every mount.
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isMobile;
}

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

export type { JobsResponse };

export function useJobsQuery() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: ({ signal }) => api.getJobs({ signal }),
    // SSE invalidates ["jobs"] reactively (see getSSEInvalidationKeys), so this
    // timer is just a heartbeat to recover from a dropped connection. Relaxed
    // 10s → 30s.
    refetchInterval: 30_000,
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
    // SSE invalidates ["queue-status"] reactively on job progress/lifecycle
    // events, so this timer is just a heartbeat. Relaxed 5s → 30s.
    refetchInterval: 30_000,
  });
}

export const LLM_STATUS_QUERY_KEY = ["llm-status"] as const;

/** Which LLM connection is busy or offline, for the sidebar status line. SSE
 *  job lifecycle events refetch it; the interval catches hosts going down. */
export function useLlmStatusQuery() {
  return useQuery<LlmStatus>({
    queryKey: LLM_STATUS_QUERY_KEY,
    queryFn: ({ signal }) => api.getLlmStatus({ signal }),
    refetchInterval: 30_000,
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
    refetchInterval: 60_000,
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
    // Translation jobs start and finish without a YouTube event; the timer catches the GPU hold lifting.
    refetchInterval: 10_000,
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

export function useInvalidateApp() {
  const queryClient = useQueryClient();
  return useMemo(
    () => () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["queue-status"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["logs"] });
      queryClient.invalidateQueries({ queryKey: ["transcription-history"] });
      queryClient.invalidateQueries({ queryKey: ["library"] });
    },
    [queryClient]
  );
}

const SSE_EVENT_NAMES: readonly SSEEventName[] = [
  "job:progress",
  "job:start",
  "job:analysis",
  "job:done",
  "job:error",
  "job:connection",
  "job:cancelled",
  "queue:finished",
  "queue:stopped",
  "scan:complete",
  "job:stopped",
  "transcription:progress",
  "model:download",
  "youtube:playlist",
  "youtube:video",
  "youtube:cooldown",
];

type QueryKey = readonly unknown[];

const stringifyQueryKey = (queryKey: QueryKey): string => JSON.stringify(queryKey);

export function parseSSEData(raw: string): Record<string, unknown> {
  try {
    const data = JSON.parse(raw) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function getSSEInvalidationKeys(name: SSEEventName): QueryKey[] {
  switch (name) {
    // The jobs list is unpaginated (megabytes on a large library), so events
    // that carry what changed patch it (withJobEvent) instead of refetching it.
    case "job:progress":
      return [["queue-status"]];
    case "job:analysis":
      return [];
    case "job:connection":
      // Parallel runs and fallbacks emit this per chunk.
      return [["queue-status"], ["llm-status"]];
    case "job:start":
      return [["jobs"], ["queue-status"], ["llm-status"]];
    case "job:done":
    case "job:error":
    case "job:cancelled":
    case "job:stopped":
      // Library rows read live job status from the jobs list, so per-job events
      // skip the library refetch: each one walks the whole media folder.
      return [["jobs"], ["queue-status"], ["logs"], ["transcription-history"], ["llm-status"]];
    case "queue:finished":
    case "queue:stopped":
      return [["jobs"], ["queue-status"], ["logs"], ["transcription-history"], ["library"], ["llm-status"]];
    case "scan:complete":
      return [["jobs"], ["queue-status"], ["logs"], ["settings"], ["transcription-history"], ["library"]];
    case "transcription:progress":
      // Per-path progress is consumed directly by the dashboard component via
      // onEvent; it should not trigger query refetches on every tick.
      return [];
    case "model:download":
      // Per-model download progress is consumed directly by the Model Manager
      // via onEvent; it should not trigger query refetches on every tick.
      return [];
    case "youtube:playlist":
      return [["youtube"]];
    case "youtube:video":
      // Progress ticks carry a pct and patch the cached rows instead (withVideoProgress).
      // The status query is left alone: refetching it runs yt-dlp --version.
      return [["youtube", "playlists"], ["youtube", "videos"], ["youtube", "pipeline"]];
    case "youtube:cooldown":
      return [["youtube", "status"], ["youtube", "pipeline"]];
  }
}

/** A youtube:video progress tick applied to one playlist's cached rows. Ticks come from a download or a Whisper run. */
export function withVideoProgress(
  old: { videos: YoutubeVideo[] } | undefined,
  videoId: string,
  status: unknown,
  pct: number,
): { videos: YoutubeVideo[] } | undefined {
  if (!old) return old;
  const step = status === "transcribing" ? "transcribing" : "downloading";
  return { videos: old.videos.map((video) => (video.video_id === videoId ? { ...video, status: step, pct } : video)) };
}

/** Fields a job event changes on its row; the refetch that may follow fills in the rest. */
function jobEventPatch(name: SSEEventName, data: Record<string, unknown>): Partial<Job> | null {
  switch (name) {
    case "job:progress":
      return typeof data.completed === "number" && typeof data.total === "number"
        ? { completed_cues: data.completed, total_cues: data.total }
        : null;
    case "job:connection": {
      const { id, label, host, model } = data;
      return typeof id === "string" && typeof label === "string" && typeof host === "string" && typeof model === "string"
        ? { connection: { id, label, host, model } }
        : null;
    }
    case "job:analysis":
      return typeof data.analysis === "string" ? { analysis_context: data.analysis } : null;
    case "job:start":
      return { status: "translating" };
    case "job:done":
      return { status: "done", connection: null, ...(typeof data.durationSeconds === "number" ? { duration_seconds: data.durationSeconds } : {}) };
    case "job:error":
      return { status: "error", connection: null, ...(typeof data.error === "string" ? { error: data.error } : {}) };
    case "job:cancelled":
      return { status: "error", connection: null };
    case "job:stopped":
      return { status: "pending", completed_cues: 0, connection: null };
    default:
      return null;
  }
}

/** A job SSE event applied to the cached jobs list; the same object when it changes nothing. */
export function withJobEvent(
  old: JobsResponse | undefined,
  name: SSEEventName,
  data: Record<string, unknown>,
): JobsResponse | undefined {
  const jobId = data.jobId;
  const patch = jobEventPatch(name, data);
  if (!old || typeof jobId !== "number" || !patch || !old.jobs.some((job) => job.id === jobId)) return old;
  return { ...old, jobs: old.jobs.map((job) => (job.id === jobId ? { ...job, ...patch } : job)) };
}

// A status change still refetches the jobs list for the fields no event
// carries, but at most once per window: a run skipping hundreds of finished
// jobs would otherwise pull the whole list several times a second.
const JOBS_REFETCH_DELAY_MS = 2000;

/** Debounced invalidation with a longer window for the (large) jobs list than for everything else. */
export function createSseInvalidator(
  invalidate: (queryKey: QueryKey) => void,
  { delayMs = 300, jobsDelayMs = JOBS_REFETCH_DELAY_MS } = {},
) {
  const others = createDebouncedInvalidator(invalidate, delayMs);
  const jobs = createDebouncedInvalidator(invalidate, jobsDelayMs);
  return {
    schedule(queryKeys: QueryKey[]) {
      const isJobs = (key: QueryKey) => key[0] === "jobs";
      if (queryKeys.some(isJobs)) jobs.schedule(queryKeys.filter(isJobs));
      if (queryKeys.some((key) => !isJobs(key))) others.schedule(queryKeys.filter((key) => !isJobs(key)));
    },
    cancel() {
      others.cancel();
      jobs.cancel();
    },
  };
}

export function createDebouncedInvalidator(
  invalidate: (queryKey: QueryKey) => void,
  delayMs = 300,
) {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const keys = Array.from(pending.values());
    pending.clear();
    keys.forEach(invalidate);
  };

  return {
    schedule(queryKeys: QueryKey[]) {
      queryKeys.forEach((queryKey) => pending.set(stringifyQueryKey(queryKey), queryKey));
      if (timer) return;
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

// Single shared EventSource for the whole app. Multiple components call useSSE
// (App, Dashboard, ModelManager); each previously opened its OWN connection and
// ran its OWN cache invalidation, so every event fired N times and the browser's
// 6-connection-per-origin budget was burned. This singleton holds ONE connection
// and fans events out to all subscribers; invalidation runs exactly once.
type SseSingleton = {
  es: EventSource;
  invalidator: ReturnType<typeof createSseInvalidator>;
  subs: Set<SSEEventHandler>;
  reopenTimer: ReturnType<typeof setTimeout> | null;
};
let sseSingleton: SseSingleton | null = null;

function ensureSse(queryClient: ReturnType<typeof useQueryClient>): SseSingleton {
  if (sseSingleton) return sseSingleton;
  const subs = new Set<SSEEventHandler>();
  const invalidator = createSseInvalidator((queryKey) => {
    queryClient.invalidateQueries({ queryKey });
  });
  const refresh = (name?: SSEEventName) => {
    invalidator.schedule(name ? getSSEInvalidationKeys(name) : [["jobs"], ["queue-status"], ["logs"], ["transcription-history"]]);
  };

  let attempts = 0;

  const open = (): EventSource => {
    const es = new EventSource("/api/events");
    let opened = false;

    es.onopen = () => {
      // Recover the events missed while the connection was down — but only
      // after a real gap; the first open has nothing to recover.
      if (attempts > 0) refresh();
      attempts = 0;
    };

    const bind = (name: SSEEventName) => {
      es.addEventListener(name, (e) => {
        const data = parseSSEData((e as MessageEvent).data);
        // Dispatch to every subscriber; isolate so one throwing handler can't kill others.
        subs.forEach((fn) => { try { fn(name, data); } catch { /* subscriber error */ } });

        // Per-path transcription progress / per-model download progress are consumed
        // directly by their components via onEvent; they must not invalidate queries.
        if (name === "transcription:progress" || name === "model:download") return;

        if (name === "youtube:video") {
          const { videoId, playlistId, status, pct } = data as { videoId?: string; playlistId?: string; status?: unknown; pct?: number };
          if (typeof videoId === "string" && typeof playlistId === "string" && typeof pct === "number") {
            queryClient.setQueryData<{ videos: YoutubeVideo[] }>(["youtube", "videos", playlistId], (old) => withVideoProgress(old, videoId, status, pct));
            return;
          }
        }

        if (name.startsWith("job:")) queryClient.setQueryData<JobsResponse>(["jobs"], (old) => withJobEvent(old, name, data));

        refresh(name);
      });
    };

    SSE_EVENT_NAMES.forEach(bind);

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        // An HTTP-level rejection (the server's 100-client cap answers a bare
        // 503) or a dead network: EventSource does not retry these by itself,
        // and refreshing from here would storm the very server that refused
        // us. Reopen with exponential backoff; subscribers ride along.
        const delay = Math.min(30_000, 1000 * 2 ** attempts);
        attempts += 1;
        if (sseSingleton) {
          sseSingleton.reopenTimer = setTimeout(() => {
            if (sseSingleton) sseSingleton.es = open();
          }, delay);
        }
      } else if (opened) {
        // A dropped socket that EventSource is auto-retrying: recover the
        // events missed during the gap.
        refresh();
      }
    };

    return es;
  };

  sseSingleton = { es: open(), invalidator, subs, reopenTimer: null };
  return sseSingleton;
}

export function useSSE(onEvent?: SSEEventHandler) {
  const queryClient = useQueryClient();
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const s = ensureSse(queryClient);
    const sub: SSEEventHandler = (name, data) => onEventRef.current?.(name, data);
    s.subs.add(sub);
    return () => {
      s.subs.delete(sub);
      // Close the shared connection only when the last subscriber unmounts; it
      // reopens on the next mount. A pending backoff reopen dies with it.
      if (s.subs.size === 0) {
        if (s.reopenTimer) clearTimeout(s.reopenTimer);
        s.invalidator.cancel();
        s.es.close();
        sseSingleton = null;
      }
    };
  }, [queryClient]);
}

export function useMutationWithInvalidation<TData = unknown, TVars = void>(
  fn: (vars: TVars) => Promise<TData>
) {
  const invalidate = useInvalidateApp();
  return useMutation({ mutationFn: fn, onSuccess: invalidate });
}

export function useWhisperModelsQuery(enabled = true) {
  return useQuery({
    queryKey: ["whisper-models"],
    queryFn: ({ signal }) => api.listWhisperModels({ signal }),
    enabled,
    staleTime: 15_000,
  });
}

// Per-model download progress state returned by useModelDownload.
export interface ModelDownloadProgress {
  active: boolean;
  pct: number;
}

/**
 * Returns the live download-progress map (keyed by model id) plus a
 * `downloadModel` function that kicks off a download, streams progress via
 * SSE, invalidates the models query on completion, and resolves when done.
 * Shared by the Whisper page and the Settings model manager so both follow
 * the same clearing rule.
 */
export function useModelDownload() {
  const queryClient = useQueryClient();
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadProgress>>({});

  // Listen for model:download SSE events and update progress state.
  // NOTE: we intentionally do NOT delete the entry on error/done here — the
  // downloadModel finally block is the single authoritative place that clears
  // the entry once the HTTP promise settles. Deleting here while the HTTP call
  // is still in flight would allow a second parallel download to start because
  // the active guard would see no entry. Only pct updates are applied via SSE.
  useSSE(
    useCallback((type, data) => {
      if (type !== "model:download") return;
      const model = typeof data.model === "string" ? data.model : "";
      if (!model) return;
      if (typeof data.pct === "number") {
        const pct = Math.max(0, Math.min(100, data.pct));
        setDownloads((prev) => {
          // Only update if the entry already exists (i.e. the HTTP call is active);
          // ignore stray SSE events that arrive after the entry was cleared.
          if (!prev[model]) return prev;
          return { ...prev, [model]: { active: true, pct } };
        });
      }
    }, []),
  );

  /**
   * Starts a model download and waits for it to finish (or throw).
   * Invalidates ["whisper-models"] after a successful download.
   */
  const downloadModel = useCallback(async (model: string): Promise<void> => {
    setDownloads((prev) => ({ ...prev, [model]: { active: true, pct: prev[model]?.pct ?? 0 } }));
    try {
      await api.downloadWhisperModel(model);
      await queryClient.invalidateQueries({ queryKey: ["whisper-models"] });
    } finally {
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[model];
        return next;
      });
    }
  }, [queryClient]);

  return { downloads, downloadModel };
}

