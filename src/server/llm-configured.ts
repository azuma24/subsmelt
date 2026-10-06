/**
 * "Has the operator actually configured an LLM?" — kept in its own module (no
 * fs, no config load) so it can be unit-tested without touching the real config
 * file. `config.ts` wires it to the raw stored settings.
 *
 * The distinction matters because DEFAULT_SETTINGS seeds a working-looking LLM
 * config: a local endpoint and a placeholder model name. `getAllSettings()`
 * merges those defaults and backfills `llm_connections` from them, so the merged
 * view a client sees always looks configured — even on a brand-new install where
 * nothing has been set up.
 *
 * Two traps this has to avoid, both found in review of the first version:
 *
 * 1. Mere persistence is not a signal. The Settings page POSTs the *entire*
 *    settings object it last read, so editing any unrelated field writes the
 *    synthesized `llm_connections` back to disk. Checking only "is a connection
 *    stored?" therefore flipped to configured after, say, a chunk-size change.
 *    Stored connections are compared against the synthesized defaults instead.
 * 2. A model alone does not make a cloud connection usable. Selecting an OpenAI
 *    model without pasting a key would otherwise clear the setup checklist while
 *    every translation 401s.
 */

/** Keys whose shipped defaults make an unconfigured install look configured. */
export const LLM_SEED_KEYS = [
  "llm_endpoint",
  "model",
  "api_key",
  "cloud_api_key_openai",
  "cloud_api_key_anthropic",
  "cloud_api_key_gemini",
] as const;

/** The subset of LlmConnection this predicate needs. */
export interface ConnectionLike {
  provider?: unknown;
  model?: unknown;
  apiKey?: unknown;
  endpoint?: unknown;
  enabled?: unknown;
}

/**
 * @param stored             raw persisted settings (NOT merged with defaults)
 * @param defaults           the shipped DEFAULT_SETTINGS, for the flat-key comparison
 * @param defaultConnections connections synthesized from `defaults`; any stored
 *                           connection equivalent to one of these is the seed
 *                           being written back, not operator intent
 */
export function computeLlmConfigured(
  stored: Record<string, string>,
  defaults: Record<string, string>,
  defaultConnections: ConnectionLike[] = [],
): boolean {
  const raw = stored.llm_connections;
  if (raw && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seeds = defaultConnections.map(fingerprint);
        const configured = parsed.some(
          (c) => isUsable(c) && !seeds.includes(fingerprint(c as ConnectionLike)),
        );
        if (configured) return true;
      }
    } catch {
      // Malformed stored value — fall through to the flat-key check rather than
      // reporting "configured" off unparseable data.
    }
  }
  // Otherwise: did the operator touch any legacy flat key away from its default?
  return LLM_SEED_KEYS.some(
    (key) => stored[key] !== undefined && stored[key] !== defaults[key],
  );
}

/**
 * Mirrors `isUsable` in connections.ts — a connection needs a model, and cloud
 * providers additionally need an API key. Kept in sync deliberately: if the two
 * disagree, the checklist claims setup is done while the queue finds no usable
 * connection.
 */
function isUsable(c: unknown): boolean {
  if (!c || typeof c !== "object") return false;
  const conn = c as ConnectionLike;
  if (conn.enabled === false) return false;
  if (String(conn.model ?? "").trim() === "") return false;
  const provider = String(conn.provider ?? "local");
  return provider === "local" || String(conn.apiKey ?? "").trim() !== "";
}

/**
 * Identity for "is this the shipped seed?". Deliberately excludes apiKey: the
 * settings GET redacts secrets, so a round-tripped key is not comparable, and
 * provider+model+endpoint is already enough to tell the seeded local connection
 * apart from anything an operator would set up.
 */
function fingerprint(c: ConnectionLike): string {
  // NUL separator: it cannot occur in a provider, model or endpoint, so no pair
  // of distinct triples can collide. Written as an escape deliberately — a
  // literal NUL byte makes git treat this whole file as binary.
  return [
    String(c.provider ?? "local"),
    String(c.model ?? "").trim(),
    String(c.endpoint ?? "").trim(),
  ].join("\u0000");
}
