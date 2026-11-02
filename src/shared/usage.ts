import type { LlmProvider } from "./llm.js";

/**
 * What an LLM call was for. `single` is the line-by-line fallback after a chunk
 * failed, so its share is the retry overhead.
 */
export const USAGE_KINDS = ["analysis", "chunk", "single", "refine", "title", "convert"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** The windows GET /api/usage reports over. */
export const USAGE_RANGES = ["7d", "30d", "90d", "365d", "all"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export interface UsageTokens {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD; null only when every call it sums ran on a local or unpriced model. */
  costUsd: number | null;
}

export interface UsageTotals extends UsageTokens {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Distinct jobs with at least one call. */
  jobs: number;
  /** Distinct subtitle files with at least one call. */
  files: number;
}

export interface UsageBudget {
  monthlyTokens: number;
  /** Tokens used since `monthStart`, whatever the report's range. */
  monthTokens: number;
  monthCostUsd: number | null;
  /** First instant of the current calendar month, UTC, ISO. */
  monthStart: string;
}

export interface UsageDay extends UsageTokens {
  /** YYYY-MM-DD, UTC. */
  day: string;
}

export interface UsageByModel extends UsageTokens {
  provider: LlmProvider;
  model: string;
  connectionLabel: string;
}

export interface UsageByKind extends UsageTokens {
  kind: UsageKind;
}

export interface UsageFile extends UsageTokens {
  jobId: number | null;
  srtName: string;
}

export interface UsageCall {
  ts: string;
  jobId: number | null;
  srtName: string | null;
  kind: UsageKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** GET /api/usage. */
export interface UsageReport {
  range: UsageRange;
  /** First instant counted, ISO; null for "all". */
  from: string | null;
  to: string;
  totals: UsageTotals;
  /** null when no monthly token budget is set. */
  budget: UsageBudget | null;
  /** One entry per UTC day in the range, zeros included, oldest first. */
  daily: UsageDay[];
  /** Highest total tokens first. */
  byModel: UsageByModel[];
  byKind: UsageByKind[];
  /** Top 10 by total tokens. */
  topFiles: UsageFile[];
  /** The last 50 calls, newest first. */
  recent: UsageCall[];
}

/** DELETE /api/usage. */
export interface UsageCleared {
  ok: true;
  deleted: number;
}
