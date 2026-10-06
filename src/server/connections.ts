import { logger } from "./logger.js";
import type { CloudProvider } from "./translator.js";
import type { LlmConnection, LlmMode } from "../shared/llm.js";

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

export type { LlmConnection, LlmMode };

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
      // Parsed but not a usable array — behavior unchanged (migrate), but warn
      // so a malformed `llm_connections` setting isn't silently ignored.
      logger.warn(
        "system",
        "llm_connections parsed to a non-array (or empty); falling back to legacy flat keys"
      );
    } catch {
      // fall through to migration
    }
  }
  return migrateConnectionsFromFlat(s);
}

/** GET /api/settings sends this in place of every stored secret. */
export const REDACTED_SECRET = "__SUBSMELT_SECRET_REDACTED__";

/**
 * Put stored keys back into an `llm_connections` value posted by a client that
 * only saw them redacted. `stored` must be the effective list GET redacted,
 * which legacy flat-key installs synthesize and never save. The marker is
 * never kept as a key: with nothing to restore, the key becomes "".
 */
export function restoreRedactedApiKeys(value: string, stored: LlmConnection[]): string {
  let incoming: unknown;
  try {
    incoming = JSON.parse(value);
  } catch {
    return value;
  }
  if (!Array.isArray(incoming)) return value;
  const storedKeys = new Map(stored.map((c) => [c.id, c.apiKey]));
  return JSON.stringify(
    incoming.map((connection) => {
      if (!connection || typeof connection !== "object" || connection.apiKey !== REDACTED_SECRET) {
        return connection;
      }
      const key = storedKeys.get(connection.id);
      return { ...connection, apiKey: key && key !== REDACTED_SECRET ? key : "" };
    })
  );
}

const trimTrailingSlashes = (url: string) => url.trim().replace(/\/+$/, "");

/**
 * The key for a test or model-list request. A key the request carries wins;
 * the redaction marker counts as none. Otherwise the saved connection named by
 * `connectionId` lends its key, but only to where it was saved for: the same
 * provider and, for local, the same endpoint (`endpoint` is the one the request
 * will call). Cloud providers ignore the endpoint and always call their own host.
 */
export function resolveRequestApiKey(
  request: { apiKey?: string; connectionId?: string; provider: string; endpoint: string },
  connections: LlmConnection[],
): string | undefined {
  if (request.apiKey && request.apiKey !== REDACTED_SECRET) return request.apiKey;
  const saved = connections.find((c) => c.id === request.connectionId);
  if (!saved?.apiKey || saved.provider !== request.provider) return undefined;
  if (saved.provider === "local" && trimTrailingSlashes(saved.endpoint) !== trimTrailingSlashes(request.endpoint)) {
    return undefined;
  }
  return saved.apiKey;
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

/**
 * A connection is usable if it has a model and (for cloud) an API key.
 *
 * Mirrored by `isUsable` in llm-configured.ts, which decides whether the setup
 * checklists are satisfied. Keep the two in sync: if that one is more lenient,
 * the UI reports setup complete while this one finds no usable connection and
 * every translation fails.
 */
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
    const matched = all.find((c) => c.id === activeId);
    if (!matched && all.length > 0) {
      // Behavior unchanged (use all[0]), but warn so a stale/invalid active id
      // isn't silently resolved to an unexpected connection.
      logger.warn(
        "system",
        `Active connection id "${activeId}" not found; falling back to "${all[0].id}"`
      );
    }
    const active = matched || all[0];
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
