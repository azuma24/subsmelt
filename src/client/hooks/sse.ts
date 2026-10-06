import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Job, JobsResponse, YoutubeVideo } from "../types";

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
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
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
      // The YouTube pipeline's GPU hold follows the translation queue.
      return [["jobs"], ["queue-status"], ["llm-status"], ["youtube", "pipeline"]];
    case "job:done":
    case "job:error":
    case "job:cancelled":
    case "job:stopped":
      // Library rows read live job status from the jobs list, so per-job events
      // skip the library refetch: each one walks the whole media folder.
      return [["jobs"], ["queue-status"], ["logs"], ["transcription-history"], ["llm-status"], ["youtube", "pipeline"]];
    case "queue:finished":
    case "queue:stopped":
      return [
        ["jobs"],
        ["queue-status"],
        ["logs"],
        ["transcription-history"],
        ["library"],
        ["llm-status"],
        ["youtube", "pipeline"],
      ];
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
      return [
        ["youtube", "playlists"],
        ["youtube", "videos"],
        ["youtube", "pipeline"],
      ];
    case "youtube:cooldown":
      return [
        ["youtube", "status"],
        ["youtube", "pipeline"],
      ];
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
      return typeof id === "string" &&
        typeof label === "string" &&
        typeof host === "string" &&
        typeof model === "string"
        ? { connection: { id, label, host, model } }
        : null;
    }
    case "job:analysis":
      return typeof data.analysis === "string" ? { analysis_context: data.analysis } : null;
    case "job:start":
      return { status: "translating" };
    case "job:done":
      return {
        status: "done",
        connection: null,
        ...(typeof data.durationSeconds === "number" ? { duration_seconds: data.durationSeconds } : {}),
      };
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

export function createDebouncedInvalidator(invalidate: (queryKey: QueryKey) => void, delayMs = 300) {
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

// Whether the shared EventSource is open. Queries that SSE keeps fresh poll
// slowly while it is, and at their full rate while it is not (a proxy that
// buffers event streams, a dropped socket mid-reconnect).
const connection = { open: false, listeners: new Set<() => void>() };

function setConnectionOpen(open: boolean): void {
  if (connection.open === open) return;
  connection.open = open;
  connection.listeners.forEach((listener) => listener());
}

const subscribeConnection = (listener: () => void) => {
  connection.listeners.add(listener);
  return () => connection.listeners.delete(listener);
};

export function useSseConnected(): boolean {
  return useSyncExternalStore(
    subscribeConnection,
    () => connection.open,
    () => false,
  );
}

/**
 * A refetch interval that backs off while SSE is delivering: the full rate
 * recovers from a dead stream, the slow rate only catches what no event
 * carries.
 */
export function useSsePollInterval(whenDisconnectedMs: number, whenConnectedMs: number): number {
  return useSseConnected() ? whenConnectedMs : whenDisconnectedMs;
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
    invalidator.schedule(
      name ? getSSEInvalidationKeys(name) : [["jobs"], ["queue-status"], ["logs"], ["transcription-history"]],
    );
  };

  let attempts = 0;

  const open = (): EventSource => {
    const es = new EventSource("/api/events");
    let opened = false;

    es.onopen = () => {
      opened = true;
      setConnectionOpen(true);
      // Recover the events missed while the connection was down — but only
      // after a real gap; the first open has nothing to recover.
      if (attempts > 0) refresh();
      attempts = 0;
    };

    const bind = (name: SSEEventName) => {
      es.addEventListener(name, (e) => {
        const data = parseSSEData((e as MessageEvent).data);
        // Dispatch to every subscriber; isolate so one throwing handler can't kill others.
        subs.forEach((fn) => {
          try {
            fn(name, data);
          } catch {
            /* subscriber error */
          }
        });

        // Per-path transcription progress / per-model download progress are consumed
        // directly by their components via onEvent; they must not invalidate queries.
        if (name === "transcription:progress" || name === "model:download") return;

        if (name === "youtube:video") {
          const { videoId, playlistId, status, pct } = data as {
            videoId?: string;
            playlistId?: string;
            status?: unknown;
            pct?: number;
          };
          if (typeof videoId === "string" && typeof playlistId === "string" && typeof pct === "number") {
            queryClient.setQueryData<{ videos: YoutubeVideo[] }>(["youtube", "videos", playlistId], (old) =>
              withVideoProgress(old, videoId, status, pct),
            );
            return;
          }
        }

        if (name.startsWith("job:"))
          queryClient.setQueryData<JobsResponse>(["jobs"], (old) => withJobEvent(old, name, data));

        refresh(name);
      });
    };

    SSE_EVENT_NAMES.forEach(bind);

    es.onerror = () => {
      setConnectionOpen(false);
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
        setConnectionOpen(false);
        sseSingleton = null;
      }
    };
  }, [queryClient]);
}
