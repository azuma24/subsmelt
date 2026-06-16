// ── Approximate LLM pricing ───────────────────────────────────────────────
//
// APPROXIMATE, EDITABLE price table for estimating translation cost from token
// usage. Prices are USD per 1,000,000 tokens (input / output) and reflect public
// list prices at the time of writing — they drift over time, so treat every
// figure as a rough estimate and update as needed. Local / self-hosted models
// have no per-token cost and are intentionally absent (estimateCost → null).
//
// Matching is case-insensitive and prefix/substring based so dated model ids
// (e.g. "gpt-4o-2024-08-06", "claude-3-5-sonnet-20241022") still resolve.

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
}

/**
 * Per-model price table (USD per 1M tokens). Keys are lowercase model-id
 * fragments matched as a prefix/substring against the job's model. Order
 * matters only for readability — lookup tries an exact match first, then the
 * longest matching key, so more specific ids win over generic ones.
 *
 * APPROXIMATE — verify against the provider's current pricing before relying on
 * these numbers for anything but a rough indication.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
  "o1-mini": { input: 1.1, output: 4.4 },
  "o1": { input: 15, output: 60 },

  // Anthropic
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-haiku-4": { input: 1, output: 5 },

  // Google Gemini
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
};

/**
 * Resolve the price entry for a model id. Tries an exact (lowercased) match
 * first, then the longest table key contained in the model id, so dated/suffixed
 * ids still resolve. Returns null when nothing matches (unknown / local model).
 */
export function lookupModelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model || typeof model !== "string") return null;
  const key = model.toLowerCase().trim();
  if (!key) return null;
  if (MODEL_PRICES[key]) return MODEL_PRICES[key];

  // Strip a leading "models/" (Gemini) or "<provider>/" namespace.
  const bare = key.replace(/^models\//, "").split("/").pop() ?? key;
  if (MODEL_PRICES[bare]) return MODEL_PRICES[bare];

  // Longest substring match wins (more specific id beats a generic prefix).
  let best: ModelPrice | null = null;
  let bestLen = 0;
  for (const [k, v] of Object.entries(MODEL_PRICES)) {
    if ((key.includes(k) || bare.includes(k)) && k.length > bestLen) {
      best = v;
      bestLen = k.length;
    }
  }
  return best;
}

/**
 * Estimate the USD cost of a translation given the model and token counts.
 * Returns null when the model is unknown / local (tokens are still tracked
 * elsewhere — only the dollar estimate is unavailable). The result is APPROXIMATE.
 */
export function estimateCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number
): number | null {
  const price = lookupModelPrice(model);
  if (!price) return null;
  const inTok = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const outTok = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
  return (inTok / 1_000_000) * price.input + (outTok / 1_000_000) * price.output;
}
