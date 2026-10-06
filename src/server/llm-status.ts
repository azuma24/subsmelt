import type { ResolvedConnection } from "./connections.js";
import type { LlmConnectionState, LlmConnectionStatus, LlmMode, LlmStatus } from "../shared/llm.js";
import { connectionModelsUrl } from "./translator/connection-health.js";
import { cloudModelsRequest } from "./routes/models.js";

/**
 * The sidebar's view of the LLM pool: which connection is translating which
 * job, and which ones answer at all.
 *
 * What the queue knows wins over a probe: a connection running a job is in use,
 * one the queue gave up on this run is offline. Everything else is probed at its
 * /models endpoint, the same check the queue runs before translating, with a
 * short timeout and a cache so a polling client never hammers a backend.
 */

export type { LlmConnectionState, LlmConnectionStatus, LlmStatus };

export type Reachability = "reachable" | "offline" | "unknown";
export type ReachabilityProbe = (conn: ResolvedConnection) => Promise<Reachability>;

export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_CACHE_MS = 60_000;

const CLOUD_HOSTS: Record<string, string> = {
  openai: "api.openai.com",
  anthropic: "api.anthropic.com",
  gemini: "generativelanguage.googleapis.com",
};

/** host[:port] only: never the scheme, path, or any credentials in the URL. */
export function connectionHost(conn: ResolvedConnection): string {
  if (conn.provider) return CLOUD_HOSTS[conn.provider] ?? conn.provider;
  try {
    return new URL(conn.apiHost).host;
  } catch {
    return "";
  }
}

interface ProbeOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

/**
 * A /models probe with a per-host cache. Concurrent callers share one request.
 *
 * Cloud providers are asked at their own models endpoint with their own auth, so
 * an expired or revoked key shows offline instead of green. (A key with no
 * credit left still lists models; only a translation request reveals that.) A
 * local host whose URL does not parse is "unknown".
 */
export function createReachabilityProbe(options: ProbeOptions = {}): ReachabilityProbe {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PROBE_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const cache = new Map<string, { at: number; result: Promise<Reachability> }>();

  async function request(url: string, headers: Record<string, string> | undefined): Promise<Reachability> {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel();
      return res.ok ? "reachable" : "offline";
    } catch {
      return "offline";
    }
  }

  return (conn) => {
    const cloud = conn.provider ? cloudModelsRequest(conn.provider, conn.apiKey) : null;
    if (cloud && !conn.apiKey) return Promise.resolve("offline");
    const url = cloud?.url ?? connectionModelsUrl(conn);
    if (!url) return Promise.resolve("unknown");
    const headers = cloud?.headers ?? (conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : undefined);
    // The key is part of the identity: a host may answer one key and refuse another.
    const key = `${url}\u0000${conn.apiKey}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.result;
    const result = request(url, headers);
    cache.set(key, { at: now(), result });
    return result;
  };
}

interface BuildInput {
  mode: LlmMode;
  /** Connections in fallback order, primary first. */
  pool: ResolvedConnection[];
  /** Translating jobs and the connection each one runs on, as the job resolved it. */
  activeJobs: { jobId: number; id: string; label: string; host: string; model: string }[];
  /** Connections the queue marked unavailable for the current run. */
  offlineIds: Iterable<string>;
  probe: ReachabilityProbe;
}

export async function buildLlmStatus({ mode, pool, activeJobs, offlineIds, probe }: BuildInput): Promise<LlmStatus> {
  const offline = new Set(offlineIds);
  const connections = await Promise.all(
    pool.map(async (conn): Promise<LlmConnectionStatus> => {
      const jobIds = activeJobs.filter((job) => job.id === conn.id).map((job) => job.jobId).sort((a, b) => a - b);
      return {
        id: conn.id,
        label: conn.label,
        model: conn.model,
        host: connectionHost(conn),
        state: await stateOf(conn, jobIds, offline, probe),
        jobIds,
      };
    }),
  );
  // A job keeps the connection it started with, so one edited out of Settings mid-job is still working.
  const configured = new Set(pool.map((conn) => conn.id));
  const leftovers = new Map<string, LlmConnectionStatus>();
  for (const job of activeJobs) {
    if (configured.has(job.id)) continue;
    const row = leftovers.get(job.id) ?? { id: job.id, label: job.label, model: job.model, host: hostOf(job.host), state: "in_use", jobIds: [] };
    row.jobIds = [...row.jobIds, job.jobId].sort((a, b) => a - b);
    leftovers.set(job.id, row);
  }
  return { mode, connections: [...connections, ...leftovers.values()] };
}

/** The host of a job's endpoint, without any credentials in the URL. */
function hostOf(apiHost: string): string {
  try {
    return new URL(apiHost).host;
  } catch {
    return "";
  }
}

async function stateOf(
  conn: ResolvedConnection,
  jobIds: number[],
  offline: Set<string>,
  probe: ReachabilityProbe,
): Promise<LlmConnectionState> {
  if (jobIds.length > 0) return "in_use";
  if (offline.has(conn.id)) return "offline";
  const reachability = await probe(conn);
  if (reachability === "reachable") return "idle";
  return reachability;
}
