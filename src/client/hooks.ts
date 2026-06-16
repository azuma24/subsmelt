import { useEffect, useMemo, useRef, useState } from "react";
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
  | "transcription:progress";

export type SSEEventHandler = (type: SSEEventName, data: Record<string, unknown>) => void;

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
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
    refetchInterval: 10_000,
  });
}

export function useLogsQuery(level?: string, category?: string, jobId?: number | null) {
  return useQuery<LogEntry[]>({
    queryKey: ["logs", level, category, jobId ?? null],
    queryFn: ({ signal }) => api.getLogs({ level: level || undefined, category: category || undefined, jobId: typeof jobId === "number" ? jobId : undefined, limit: 300 }, { signal }),
    refetchInterval: 3_000,
  });
}

export function useQueueStatusQuery() {
  return useQuery<QueueStatus>({
    queryKey: ["queue-status"],
    queryFn: ({ signal }) => api.getQueueStatus({ signal }),
    refetchInterval: 5_000,
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

export function useSSE(onEvent?: SSEEventHandler) {
  const queryClient = useQueryClient();
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    const invalidator = createDebouncedInvalidator((queryKey) => {
      queryClient.invalidateQueries({ queryKey });
    });
    const refresh = (name?: SSEEventName) => {
      invalidator.schedule(name ? getSSEInvalidationKeys(name) : [["jobs"], ["queue-status"], ["logs"], ["transcription-history"]]);
    };

    const bind = (name: SSEEventName) => {
      es.addEventListener(name, (e) => {
        const data = parseSSEData((e as MessageEvent).data);
        onEventRef.current?.(name, data);

        // Per-path transcription progress is handled entirely by the dashboard
        // via onEvent; it must not schedule query invalidations.
        if (name === "transcription:progress") return;

        // For progress events: patch the cache directly from the SSE payload so
        // the progress bar updates immediately without waiting for a round-trip
        // refetch. This fixes the "stuck at 0%" issue where debounced invalidation
        // collapsed many progress events into a single late refetch.
        if (name === "job:progress") {
          const { jobId, completed, total } = data as { jobId?: number; completed?: number; total?: number };
          if (typeof jobId === "number" && typeof completed === "number" && typeof total === "number") {
            queryClient.setQueryData(["jobs"], (old: Job[] | undefined) => {
              if (!old) return old;
              return old.map((job) =>
                job.id === jobId
                  ? { ...job, completed_cues: completed, total_cues: total }
                  : job
              );
            });
            // Still invalidate queue-status so the header badge stays current
            invalidator.schedule([["queue-status"]]);
            return;
          }
        }

        refresh(name);
      });
    };

    SSE_EVENT_NAMES.forEach(bind);
    es.onerror = () => refresh();

    return () => {
      invalidator.cancel();
      es.close();
    };
  }, [queryClient]);
}

export function useMutationWithInvalidation<TData = unknown, TVars = void>(
  fn: (vars: TVars) => Promise<TData>
) {
  const invalidate = useInvalidateApp();
  return useMutation({ mutationFn: fn, onSuccess: invalidate });
}
