import type { CloudProvider } from "./translator.js";

// ── Multi-connection model ────────────────────────────────────────────────
//
// SubSmelt supports multiple LLM "connections" that can be used in three modes:
//   - single:   one active connection (legacy behavior)
//   - fallback: ordered list; cascade to the next connection when one fails
//   - parallel: distribute chunks across connections for throughput
//
// Connections are stored as a JSON string under the `llm_connections` setting.
// For backward compatibility, when that setting is empty we synthesize the
// array from the legacy flat keys (cloud_provider / cloud_api_key_* / etc.).

export type LlmMode = "single" | "fallback" | "parallel";

export interface LlmConnection {
  /** Stable identifier (e.g. "local", "openai", or a generated slug). */
  id: string;
  /** User-facing name. */
  label: string;
  provider: CloudProvider; // "local" | "openai" | "anthropic" | "gemini"
  apiKey: string;
  model: string;
  /** Only meaningful for local / OpenAI-compatible providers. */
  endpoint: string;
  enabled: boolean;
  /** Priority for fallback; tie-break for parallel. Lower runs first. */
  order: number;
}

/** A connection resolved into the shape the translator consumes. */
export interface ResolvedConnection {
  id: string;
  label: string;
  /** undefined for local → routed through the OpenAI-compatible client. */
  provider?: CloudProvider;
  apiKey: string;
  apiHost: string;
  model: string;
}

const DEFAULT_LOCAL_ENDPOINT = "http://localhost:8000/v1";
const CLOUD_PROVIDERS: CloudProvider[] = ["openai", "anthropic", "gemini"];
const ALL_PROVIDERS: CloudProvider[] = ["local", ...CLOUD_PROVIDERS];

function providerLabel(p: CloudProvider): string {
  switch (p) {
    case "openai": return "OpenAI";
    case "anthropic": return "Anthropic";
    case "gemini": return "Gemini";
    default: return "Local";
  }
}

/**
 * Build a connections array from the legacy flat settings keys.
 * Always includes the local connection; adds a cloud connection for each
 * provider that has an API key configured.
 */
export function migrateConnectionsFromFlat(s: Record<string, string>): LlmConnection[] {
  const out: LlmConnection[] = [
    {
      id: "local",
      label: "Local",
      provider: "local",
      apiKey: s.api_key || "",
      model: s.model || "",
      endpoint: s.llm_endpoint || DEFAULT_LOCAL_ENDPOINT,
      enabled: true,
      order: 0,
    },
  ];

  let order = 1;
  for (const p of CLOUD_PROVIDERS) {
    const apiKey = s[`cloud_api_key_${p}`] || "";
    const model = s[`cloud_model_${p}`] || "";
    if (apiKey) {
      out.push({
        id: p,
        label: providerLabel(p),
        provider: p,
        apiKey,
        model,
        endpoint: "",
        enabled: true,
        order: order++,
      });
    }
  }
  return out;
}

function normalizeConnection(c: unknown, index: number): LlmConnection {
  const obj = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  const provider = (ALL_PROVIDERS.includes(obj.provider as CloudProvider)
    ? obj.provider
    : "local") as CloudProvider;
  return {
    id: String(obj.id || provider || `conn-${index}`),
    label: String(obj.label || providerLabel(provider)),
    provider,
    apiKey: String(obj.apiKey || ""),
    model: String(obj.model || ""),
    endpoint: String(obj.endpoint || (provider === "local" ? DEFAULT_LOCAL_ENDPOINT : "")),
    enabled: obj.enabled !== false,
    order: typeof obj.order === "number" ? obj.order : index,
  };
}

/**
 * Parse the `llm_connections` setting. Falls back to migrating from the legacy
 * flat keys when the setting is empty or invalid.
 */
export function parseConnections(s: Record<string, string>): LlmConnection[] {
  const raw = s.llm_connections;
  if (raw && raw.trim()) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map(normalizeConnection);
      }
    } catch {
      // fall through to migration
    }
  }
  return migrateConnectionsFromFlat(s);
}

function toResolved(c: LlmConnection): ResolvedConnection {
  return {
    id: c.id,
    label: c.label,
    provider: c.provider === "local" ? undefined : c.provider,
    apiKey: c.apiKey,
    apiHost: c.endpoint || DEFAULT_LOCAL_ENDPOINT,
    model: c.model,
  };
}

/** A connection is usable if it has a model and (for cloud) an API key. */
function isUsable(c: LlmConnection): boolean {
  return Boolean(c.model) && (c.provider === "local" || Boolean(c.apiKey));
}

/**
 * Resolve the active connection pool for a translation job.
 * - single:   the active connection only (legacy behavior).
 * - fallback/parallel: all enabled, usable connections sorted by order.
 */
export function resolveConnectionPool(s: Record<string, string>): {
  mode: LlmMode;
  pool: ResolvedConnection[];
  all: LlmConnection[];
} {
  const all = parseConnections(s);
  const mode = (["single", "fallback", "parallel"].includes(s.llm_mode)
    ? s.llm_mode
    : "single") as LlmMode;

  let chosen: LlmConnection[];
  if (mode === "single") {
    const activeId = s.active_connection_id || s.cloud_provider || "local";
    const active = all.find((c) => c.id === activeId) || all[0];
    chosen = active ? [active] : [];
  } else {
    chosen = all
      .filter((c) => c.enabled && isUsable(c))
      .sort((a, b) => a.order - b.order);
    if (chosen.length === 0) {
      const first = all[0];
      chosen = first ? [first] : [];
    }
  }

  return { mode, pool: chosen.map(toResolved), all };
}
