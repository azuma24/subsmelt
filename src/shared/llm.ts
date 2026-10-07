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
}

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

/** GET /api/llm-health. */
export interface LlmHealth {
  ok: boolean;
  endpointReachable: boolean;
  modelConfigured: boolean;
  modelAvailable: boolean;
  model?: string;
  modelCount?: number;
  status?: number;
  reason?: string;
  message?: string;
}
