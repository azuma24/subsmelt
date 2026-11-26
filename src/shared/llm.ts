export type LlmProvider = "local" | "openai" | "anthropic" | "gemini";
export type LlmMode = "single" | "fallback" | "parallel";

/** One LLM connection as stored in the llm_connections setting. */
export interface LlmConnection {
  /** Stable identifier (e.g. "local", "openai", or a generated slug). */
  id: string;
  /** User-facing name. */
  label: string;
  provider: LlmProvider;
  apiKey: string;
  model: string;
  /** Only meaningful for local / OpenAI-compatible providers. */
  endpoint: string;
  enabled: boolean;
  /** Priority for fallback; tie-break for parallel. Lower runs first. */
  order: number;
  /**
   * Reasoning effort to ask for again when a reply runs into the output limit:
   * one of {@link REASONING_EFFORTS}, or {@link CUT_OFF_RETRY_OFF} to let such a
   * reply fail over to the next connection. Unset means
   * {@link DEFAULT_CUT_OFF_RETRY_EFFORT}. Local only: which value means "think
   * less" differs by server.
   */
  cutOffRetryEffort?: string;
}

export const CUT_OFF_RETRY_OFF = "off";
/** Stops the reasoning of the one server it was measured on; a server that ignores it just answers again. */
export const DEFAULT_CUT_OFF_RETRY_EFFORT = "low";

/** The values a server may accept as `reasoning_effort`. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;

/** GET /api/llm/status: the pool in fallback order, primary first. */
export type LlmConnectionState = "in_use" | "idle" | "offline" | "unknown";

export interface LlmConnectionStatus {
  id: string;
  label: string;
  model: string;
  /** host[:port], or the cloud provider's API host. */
  host: string;
  state: LlmConnectionState;
  /** Translating jobs on this connection; empty unless state is in_use. */
  jobIds: number[];
}

export interface LlmStatus {
  mode: LlmMode;
  connections: LlmConnectionStatus[];
}
