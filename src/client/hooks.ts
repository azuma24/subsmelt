import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type { JobPreview, LlmHealth, LogEntry, QueueStatus, Task } from "./types";

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
  return useQuery({ queryKey: ["settings"], queryFn: api.getSettings, staleTime: 30_000 });
}

export function useTasksQuery() {
  return useQuery<Task[]>({ queryKey: ["tasks"], queryFn: api.getTasks, staleTime: 10_000 });
}

export function useJobsQuery() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: api.getJobs,
    refetchInterval: 10_000,
  });
}

export function useLogsQuery(level?: string, category?: string, jobId?: number | null) {
  return useQuery<LogEntry[]>({
    queryKey: ["logs", level, category, jobId ?? null],
    queryFn: () => api.getLogs({ level: level || undefined, category: category || undefined, jobId: typeof jobId === "number" ? jobId : undefined, limit: 300 }),
    refetchInterval: 3_000,
  });
}

export function useQueueStatusQuery() {
  return useQuery<QueueStatus>({
    queryKey: ["queue-status"],
    queryFn: api.getQueueStatus,
    refetchInterval: 5_000,
  });
}

export function useLlmHealthQuery(enabled = true) {
  return useQuery<LlmHealth>({
    queryKey: ["llm-health"],
    queryFn: api.getLlmHealth,
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function useJobPreview(jobId: number | null) {
  return useQuery<JobPreview>({
    queryKey: ["job-preview", jobId],
    queryFn: () => api.getJobPreview(jobId as number),
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
