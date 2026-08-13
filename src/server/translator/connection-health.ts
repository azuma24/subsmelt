import type { ResolvedConnection } from "../connections.js";

/**
 * Per-job connection health: availability probing, the timeout breaker, and the
 * acquire/release wrapper.
 *
 * This lived as a set of closures inside `translateFile`, which meant none of it
 * could be tested — including the breaker that decides when to stop hammering a
 * backend that has stopped answering. Everything here is state scoped to one
 * job, so it is created per call rather than shared at module level.
 */

/** Timeouts on one connection before it is dropped for the rest of the job. */
export const CONNECTION_TIMEOUT_LIMIT = 3;
/** Attempts made to reach a connection's /models endpoint before giving up. */
export const OFFLINE_ATTEMPTS = 5;
/** Delay between availability probes, and the probe's own timeout. */
export const OFFLINE_RETRY_MS = 5_000;

export interface ConnectionEvent {
  id: string;
  label: string;
  error: string;
}

export interface ConnectionHealthOptions {
  onConnectionUnavailable?: (info: ConnectionEvent) => void;
  onRetry?: (attempt: number, error: unknown, backoff: number, maxRetries?: number) => void;
  /** Serializes requests per connection; returns a release function. */
  acquireConnection?: (conn: ResolvedConnection) => Promise<() => void>;
  /** Connections the caller already holds a lock for — do not re-acquire. */
  reservedConnectionIds?: Iterable<string>;
  abortSignal?: AbortSignal;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  delayImpl?: (ms: number) => Promise<void>;
}

export interface ConnectionHealth {
  /** Record a failure; transport stalls count toward the breaker. */
  noteFailure(conn: ResolvedConnection, error: unknown): void;
  /** The subset of `order` not yet dropped by the breaker. */
  live(order: ResolvedConnection[]): ResolvedConnection[];
  isDisabled(id: string): boolean;
  /** True once a probe has failed all its attempts for this connection. */
  isUnavailable(id: string): boolean;
  /** Probe availability once per job; throws when the connection is unreachable. */
  ensureReady(conn: ResolvedConnection): Promise<void>;
  /** ensureReady + lock acquisition around `fn`, releasing in a finally. */
  withConnection<T>(conn: ResolvedConnection, fn: () => Promise<T>): Promise<T>;
}

/**
 * URL of a connection's /models endpoint, or null when probing does not apply.
 *
 * Cloud SDK providers do not share a single /models endpoint or auth shape; they
 * fail fast inside their own SDK call. The probe exists for local and
 * OpenAI-compatible hosts, where an offline LM Studio/Ollama/vLLM would
 * otherwise be retried on every chunk.
 */
export function connectionModelsUrl(conn: ResolvedConnection): string | null {
  if (conn.provider) return null;
  try {
    const base = new URL(conn.apiHost);
    base.pathname = `${base.pathname.replace(/\/$/, "")}/models`;
    base.search = "";
    base.hash = "";
    return base.toString();
  } catch {
    return null;
  }
}

/** Best-effort human message from a probe failure. */
export function offlineMessage(error: unknown): string {
  const err = error as any;
  return String(err?.message || err?.cause?.message || error || "connection unavailable");
}

/**
 * True when an error looks like a transport stall rather than a bad response.
 *
 * A schema mismatch is the model misbehaving on one chunk, not the endpoint
 * being down — dropping a connection for that would be wrong.
 *
 * Note "timed out" as well as "timeout": the phrasing differs by layer
 * (`Request timeout after 300000ms` from ai-client, `... timed out after 300s`
 * from the transcription client), and matching only one of them meant the
 * breaker never tripped on the most common message.
 */
const TRANSPORT_MARKERS = [
  "timed out",
  "timeout",
  "etimedout",
  "network",
  "fetch failed",
  "econnreset",
  "econnrefused",
  "socket hang up",
];

export function isTransportFailure(error: unknown): boolean {
  const message = String((error as any)?.message || error).toLowerCase();
  return TRANSPORT_MARKERS.some((marker) => message.includes(marker));
}

export function createConnectionHealth(options: ConnectionHealthOptions = {}): ConnectionHealth {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delay = options.delayImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reserved = new Set(options.reservedConnectionIds ?? []);

  const timeoutCounts = new Map<string, number>();
  const disabled = new Set<string>();
  const unavailable = new Set<string>();
  const verified = new Set<string>();

  function noteFailure(conn: ResolvedConnection, error: unknown): void {
    if (!isTransportFailure(error)) return;
    const count = (timeoutCounts.get(conn.id) ?? 0) + 1;
    timeoutCounts.set(conn.id, count);
    if (count >= CONNECTION_TIMEOUT_LIMIT && !disabled.has(conn.id)) {
      disabled.add(conn.id);
      options.onConnectionUnavailable?.({
        id: conn.id,
        label: conn.label,
        error: `${count} timeouts in this job — skipping for the rest of it`,
      });
    }
  }

  async function ensureReady(conn: ResolvedConnection): Promise<void> {
    if (unavailable.has(conn.id)) {
      throw new Error(`Connection marked unavailable: ${conn.label}`);
    }
    if (verified.has(conn.id)) return;

    const modelsUrl = connectionModelsUrl(conn);
    if (!modelsUrl) {
      verified.add(conn.id);
      return;
    }

    let lastErr: unknown;
    for (let attempt = 1; attempt <= OFFLINE_ATTEMPTS; attempt++) {
      if (options.abortSignal?.aborted) throw new Error("STOP_REQUESTED");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("connection_probe_timeout"), OFFLINE_RETRY_MS);
      try {
        const res = await fetchImpl(modelsUrl, {
          method: "GET",
          headers: conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : undefined,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${modelsUrl}`);
        verified.add(conn.id);
        return;
      } catch (error) {
        lastErr = error;
        if (attempt >= OFFLINE_ATTEMPTS) break;
        options.onRetry?.(attempt, error, OFFLINE_RETRY_MS, OFFLINE_ATTEMPTS);
        await delay(OFFLINE_RETRY_MS);
      } finally {
        clearTimeout(timer);
      }
    }

    unavailable.add(conn.id);
    const error = offlineMessage(lastErr);
    options.onConnectionUnavailable?.({ id: conn.id, label: conn.label, error });
    throw new Error(`Connection unavailable after ${OFFLINE_ATTEMPTS} attempts: ${conn.label} — ${error}`);
  }

  async function withConnection<T>(conn: ResolvedConnection, fn: () => Promise<T>): Promise<T> {
    await ensureReady(conn);
    const release = reserved.has(conn.id) ? undefined : await options.acquireConnection?.(conn);
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  return {
    noteFailure,
    live: (order) => order.filter((conn) => !disabled.has(conn.id)),
    isDisabled: (id) => disabled.has(id),
    isUnavailable: (id) => unavailable.has(id),
    ensureReady,
    withConnection,
  };
}
