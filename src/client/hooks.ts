import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type { Job, JobPreview, LlmHealth, LogEntry, QueueStatus, Task, TranscriptionHealth, TranscriptionHistoryEntry } from "./types";

export type SSEEventName =
  | "job:progress"
  | "job:start"
  | "job:done"
  | "job:error"
  | "queue:finished"
  | "queue:stopped"
  | "scan:complete"
  | "job:stopped"
  | "transcription:progress"
  | "model:download";

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

export function useLlmHealthQuery(enabled = true) {
  return useQuery<LlmHealth>({
    queryKey: ["llm-health"],
    queryFn: ({ signal }) => api.getLlmHealth({ signal }),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
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
    },
    [queryClient]
  );
}

const SSE_EVENT_NAMES: readonly SSEEventName[] = [
  "job:progress",
  "job:start",
  "job:done",
  "job:error",
  "queue:finished",
  "queue:stopped",
  "scan:complete",
  "job:stopped",
  "transcription:progress",
  "model:download",
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
    case "job:progress":
    case "job:start":
      return [["jobs"], ["queue-status"]];
    case "job:done":
    case "job:error":
    case "job:stopped":
    case "queue:finished":
    case "queue:stopped":
      return [["jobs"], ["queue-status"], ["logs"], ["transcription-history"]];
    case "scan:complete":
      return [["jobs"], ["queue-status"], ["logs"], ["settings"], ["transcription-history"]];
    case "transcription:progress":
      // Per-path progress is consumed directly by the dashboard component via
      // onEvent; it should not trigger query refetches on every tick.
      return [];
    case "model:download":
      // Per-model download progress is consumed directly by the Model Manager
      // via onEvent; it should not trigger query refetches on every tick.
      return [];
  }
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
  invalidator: ReturnType<typeof createDebouncedInvalidator>;
  subs: Set<SSEEventHandler>;
};
let sseSingleton: SseSingleton | null = null;

function ensureSse(queryClient: ReturnType<typeof useQueryClient>): SseSingleton {
  if (sseSingleton) return sseSingleton;
  const es = new EventSource("/api/events");
  const subs = new Set<SSEEventHandler>();
  const invalidator = createDebouncedInvalidator((queryKey) => {
    queryClient.invalidateQueries({ queryKey });
  });
  const refresh = (name?: SSEEventName) => {
    invalidator.schedule(name ? getSSEInvalidationKeys(name) : [["jobs"], ["queue-status"], ["logs"], ["transcription-history"]]);
  };

  const bind = (name: SSEEventName) => {
    es.addEventListener(name, (e) => {
      const data = parseSSEData((e as MessageEvent).data);
      // Dispatch to every subscriber; isolate so one throwing handler can't kill others.
      subs.forEach((fn) => { try { fn(name, data); } catch { /* subscriber error */ } });

      // Per-path transcription progress / per-model download progress are consumed
      // directly by their components via onEvent; they must not invalidate queries.
      if (name === "transcription:progress" || name === "model:download") return;

      if (name === "job:progress") {
        const { jobId, completed, total } = data as { jobId?: number; completed?: number; total?: number };
        if (typeof jobId === "number" && typeof completed === "number" && typeof total === "number") {
          queryClient.setQueryData(["jobs"], (old: Job[] | undefined) => {
            if (!old) return old;
            return old.map((job) => (job.id === jobId ? { ...job, completed_cues: completed, total_cues: total } : job));
          });
          invalidator.schedule([["queue-status"]]);
          return;
        }
      }

      refresh(name);
    });
  };

  SSE_EVENT_NAMES.forEach(bind);
  es.onerror = () => refresh();
  sseSingleton = { es, invalidator, subs };
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
      // reopens on the next mount.
      if (s.subs.size === 0) {
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
 *
 * The caller must already subscribe to SSE (WhisperPage calls useSSE itself).
 * We wire the SSE listener here so the hook is self-contained.
 */
export function useModelDownload(
  onProgress: (downloads: Record<string, ModelDownloadProgress>) => void,
) {
  const queryClient = useQueryClient();
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadProgress>>({});

  // Keep the onProgress callback stable via ref so the SSE handler doesn't
  // need to be re-registered on every render.
  const onProgressRef = useRef(onProgress);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);

  // Sync to caller whenever downloads changes.
  useEffect(() => { onProgressRef.current(downloads); }, [downloads]);

  // Listen for model:download SSE events and update progress state.
  useSSE(
    useCallback((type, data) => {
      if (type !== "model:download") return;
      const model = typeof data.model === "string" ? data.model : "";
      if (!model) return;
      if (data.error === true || data.done === true) {
        setDownloads((prev) => {
          const next = { ...prev };
          delete next[model];
          return next;
        });
        return;
      }
      if (typeof data.pct === "number") {
        const pct = Math.max(0, Math.min(100, data.pct));
        setDownloads((prev) => ({ ...prev, [model]: { active: true, pct } }));
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

