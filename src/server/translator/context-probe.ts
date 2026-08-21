import { logger } from "../logger.js";

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
  /** Recommended max lines for context analysis */
  recommendedAnalysisLines: number;
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
  chunkSize = 20
): Promise<ModelContextInfo> {
  const FALLBACK: ModelContextInfo = {
    maxContextTokens: null,
    recommendedParallelChunks: 1,
    recommendedAnalysisLines: 2000,
  };

  try {
    // Strip /v1 or trailing path — LM Studio native API is at the root
    const base = apiHost.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    const url = `${base}/api/v0/models`;

    // SSRF guard: only http(s) probes are allowed; private-range hosts are
    // permitted (self-hosted) but warn via isSafeHttpUrl. Invalid scheme → bail.
    if (!isSafeHttpUrl(url)) return FALLBACK;

    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return FALLBACK;

    const json = (await resp.json()) as { data?: Array<{ id: string; max_context_length?: number }> };
    const models = json?.data ?? [];
    if (models.length === 0) return FALLBACK;

    // Find the configured model by ID (case-insensitive prefix match)
    const modelLower = model.toLowerCase();
    const match =
      models.find((m) => m.id.toLowerCase() === modelLower) ??
      models.find((m) => m.id.toLowerCase().includes(modelLower.split("/").pop() ?? modelLower)) ??
      models[0]; // fallback: first loaded model

    const maxCtx = match?.max_context_length ?? null;
    if (!maxCtx) return FALLBACK;

    // Analysis lines: use up to 25% of context for the analysis prompt.
    // Rough estimate: 1 subtitle line ≈ 60 chars ≈ 15 tokens.
    // Leave ~20% headroom for system prompt + response.
    const tokensForAnalysis = Math.floor(maxCtx * 0.20);
    const tokensPerLine = 15;
    const recommendedAnalysisLines = Math.max(
      200,
      Math.min(5000, Math.floor(tokensForAnalysis / tokensPerLine))
    );

    // Parallel chunks: how many chunk-sized windows fit in 40% of context.
    // Each chunk = chunkSize cues × ~30 tokens per cue (input + output buffer).
    // Cap at 2 — beyond that, parallel requests on a single GPU thrash memory
    // and cause timeouts faster than they save time.
    const tokensPerChunk = chunkSize * 30;
    const tokensForParallel = Math.floor(maxCtx * 0.40);
    const recommendedParallelChunks = Math.max(
      1,
      Math.min(2, Math.floor(tokensForParallel / tokensPerChunk))
    );

    return { maxContextTokens: maxCtx, recommendedParallelChunks, recommendedAnalysisLines };
  } catch {
    return FALLBACK;
  }
}
