import { logger } from "../logger.js";
import type { ResolvedConnection } from "../connections.js";
import { controlledAbortError } from "./ai-client.js";

// ── Dynamic model context probing ────────────────────────────────────────────

/**
 * Best-effort safety check for an outbound probe URL.
 *
 * The probe fetches a user-configured `apiHost`, so a malicious/misconfigured
 * value could point at internal infrastructure (SSRF). This endpoint is
 * user-owned and self-hosted, and the common deployment is a local LM Studio on
 * localhost/LAN — so we deliberately do NOT hard-block private/loopback hosts
 * (that would break legitimate use). Instead we:
 *   - require an http(s) scheme (hard requirement), and
 *   - log a warning when the host resolves to a loopback/link-local/private
 *     range so the operator has visibility, while still allowing the request.
 *
 * Returns false only when the scheme is invalid — the one case worth blocking
 * outright. Private-range hosts return true but emit a warning.
 */
export function isSafeHttpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (isPrivate) {
    logger.warn(
      "translate",
      `Model-context probe targets a private/loopback host (${host}); allowing (self-hosted endpoint), but verify this is intended.`
    );
  }
  return true;
}

export interface ModelContextInfo {
  /** Maximum context window in tokens, or null if unknown */
  maxContextTokens: number | null;
  /** Recommended parallel chunks based on context size */
  recommendedParallelChunks: number;
  /** Most concurrent chunk requests the window holds, or null if unknown */
  maxParallelChunks: number | null;
  /** Recommended max lines for context analysis */
  recommendedAnalysisLines: number;
}

/** Rough size of one subtitle line: ~60 chars ≈ 15 tokens. */
const TOKENS_PER_LINE = 15;
/** Share of the window the analysis sample may fill, leaving room for the reply. */
const ANALYSIS_CONTEXT_SHARE = 0.2;
/** Below this the analysis sample says too little to be worth sending. */
export const MIN_ANALYSIS_LINES = 50;
const MAX_ANALYSIS_LINES = 5000;
/** Analysis cap when the window is unknown. */
export const DEFAULT_ANALYSIS_LINES = 2000;
/**
 * Per-request cost beyond the cues themselves: system prompt, the analysis
 * context it carries, and a thinking model's reasoning tokens.
 */
const CHUNK_REQUEST_OVERHEAD_TOKENS = 2048;
/** Input plus output tokens per cue in a chunk request. */
const TOKENS_PER_CUE = 30;
/**
 * Recommended parallelism stops at 2 — beyond that, parallel requests on a
 * single GPU thrash memory and cause timeouts faster than they save time.
 */
const RECOMMENDED_PARALLEL_CAP = 2;

const UNKNOWN_CONTEXT: ModelContextInfo = {
  maxContextTokens: null,
  recommendedParallelChunks: 1,
  maxParallelChunks: null,
  recommendedAnalysisLines: DEFAULT_ANALYSIS_LINES,
};

/** Analysis sample size that fits a window of `contextTokens`. */
export function analysisLinesFor(contextTokens: number): number {
  const lines = Math.floor((contextTokens * ANALYSIS_CONTEXT_SHARE) / TOKENS_PER_LINE);
  return Math.max(MIN_ANALYSIS_LINES, Math.min(MAX_ANALYSIS_LINES, lines));
}

/** Size analysis and chunk concurrency for a window of `contextTokens`. */
export function deriveContextInfo(contextTokens: number, chunkSize: number): ModelContextInfo {
  // LM Studio and llama.cpp share one window across concurrent requests, so
  // parallel chunks must fit side by side.
  const tokensPerRequest = CHUNK_REQUEST_OVERHEAD_TOKENS + chunkSize * TOKENS_PER_CUE;
  const maxParallelChunks = Math.max(1, Math.floor(contextTokens / tokensPerRequest));
  return {
    maxContextTokens: contextTokens,
    recommendedParallelChunks: Math.min(RECOMMENDED_PARALLEL_CAP, maxParallelChunks),
    maxParallelChunks,
    recommendedAnalysisLines: analysisLinesFor(contextTokens),
  };
}

/**
 * Probe the LM Studio native API (/api/v0/models) to get the active model's
 * context window size, then derive safe defaults for analysis line cap and
 * parallel chunk count.
 *
 * Falls back gracefully if the endpoint isn't LM Studio or the call fails —
 * returns conservative defaults so any OpenAI-compatible host works.
 */
export async function probeModelContext(
  apiHost: string,
  model: string,
  chunkSize = 20,
  abortSignal?: AbortSignal
): Promise<ModelContextInfo> {
  try {
    // Strip /v1 or trailing path — LM Studio native API is at the root
    const base = apiHost.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    const url = `${base}/api/v0/models`;

    // SSRF guard: only http(s) probes are allowed; private-range hosts are
    // permitted (self-hosted) but warn via isSafeHttpUrl. Invalid scheme → bail.
    if (!isSafeHttpUrl(url)) return UNKNOWN_CONTEXT;

    // The probe honours the job's abort signal too, so a stop or cancel that
    // lands during the probe takes effect immediately instead of at the first
    // translation call.
    const resp = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(abortSignal ? [abortSignal] : [])]) });
    if (!resp.ok) return UNKNOWN_CONTEXT;

    const json = (await resp.json()) as {
      data?: Array<{ id: string; max_context_length?: number; loaded_context_length?: number }>;
    };
    const models = json?.data ?? [];
    if (models.length === 0) return UNKNOWN_CONTEXT;

    // Find the configured model by ID (case-insensitive prefix match)
    const modelLower = model.toLowerCase();
    const match =
      models.find((m) => m.id.toLowerCase() === modelLower) ??
      models.find((m) => m.id.toLowerCase().includes(modelLower.split("/").pop() ?? modelLower)) ??
      models[0]; // fallback: first loaded model

    // LM Studio loads models with a context smaller than their maximum (often
    // 4k–8k by default) and rejects prompts beyond it, so the loaded size wins.
    const maxCtx = match?.loaded_context_length ?? match?.max_context_length ?? null;
    if (!maxCtx) return UNKNOWN_CONTEXT;

    return deriveContextInfo(maxCtx, chunkSize);
  } catch (error) {
    // A stop/cancel aborting the probe is not a probe failure — surface it so
    // the job's own handling applies instead of silently translating on.
    if (abortSignal?.aborted) throw controlledAbortError(abortSignal);
    return UNKNOWN_CONTEXT;
  }
}

export interface JobContextPlan {
  /** Probe result for each connection, by connection id. */
  byConnection: Map<string, ModelContextInfo>;
  /** Chunks to translate at once: the configured value, capped to fit the primary's window. */
  parallelChunks: number;
}

/**
 * Probe every connection a job may use, so a fallback with a smaller window
 * gets prompts sized for itself rather than for the primary.
 */
export async function planJobContext(
  connections: ResolvedConnection[],
  opts: { fallbackHost: string; chunkSize: number; configuredParallel: number; abortSignal?: AbortSignal }
): Promise<JobContextPlan> {
  const byConnection = new Map<string, ModelContextInfo>();
  for (const conn of connections) {
    // Cloud providers have no LM Studio endpoint to ask.
    const info = conn.provider
      ? UNKNOWN_CONTEXT
      : await probeModelContext(conn.apiHost || opts.fallbackHost, conn.model, opts.chunkSize, opts.abortSignal);
    byConnection.set(conn.id, info);
  }

  const primary = connections[0] ? byConnection.get(connections[0].id) : undefined;
  const wanted = opts.configuredParallel > 1 ? opts.configuredParallel : (primary?.recommendedParallelChunks ?? 1);
  const parallelChunks = Math.min(wanted, primary?.maxParallelChunks ?? wanted);
  return { byConnection, parallelChunks };
}
