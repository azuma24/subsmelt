import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type { JobPreview, LlmHealth, LogEntry, QueueStatus, Task, TranscriptionHealth, TranscriptionHistoryEntry } from "./types";

export type SSEEventName =
  | "job:progress"
  | "job:start"
  | "job:done"
  | "job:error"
  | "queue:finished"
  | "queue:stopped"
  | "scan:complete"
  | "job:stopped";

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
];

export function useSSE(onEvent?: SSEEventHandler) {
  const queryClient = useQueryClient();
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["queue-status"] });
      queryClient.invalidateQueries({ queryKey: ["logs"] });
      queryClient.invalidateQueries({ queryKey: ["transcription-history"] });
    };

    const bind = (name: SSEEventName) => {
      es.addEventListener(name, (e) => {
        const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
        onEventRef.current?.(name, data);
        refresh();
      });
    };

    SSE_EVENT_NAMES.forEach(bind);
    es.onerror = refresh;

    return () => es.close();
  }, [queryClient]);
}

export function useMutationWithInvalidation<TData = unknown, TVars = void>(
  fn: (vars: TVars) => Promise<TData>
) {
  const invalidate = useInvalidateApp();
  return useMutation({ mutationFn: fn, onSuccess: invalidate });
}
