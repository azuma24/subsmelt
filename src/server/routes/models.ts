import type { Express } from "express";
import { getAllSettings } from "../config.js";
import { testConnection } from "../translator.js";
import { parseConnections, resolveConnectionPool, resolveRequestApiKey } from "../connections.js";
import type { CloudProvider } from "../translator.js";
import { logger } from "../logger.js";
import { errorMessage, errorName } from "../errors.js";

// ======== List Models ========
// Basic SSRF guard for a caller-supplied `endpoint` override. We intentionally
// DO NOT block private/RFC1918 ranges — local LLM backends (e.g. localhost,
// 192.168.x.x) are the primary, legitimate use case here. We only reject values
// that don't parse as an http(s) URL, which stops `file://`, `gopher://`, etc.
// and obviously malformed input. Returns the normalized origin+path (trailing
// slashes stripped) or null when the value is unusable.
function sanitizeLlmEndpoint(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return trimmed.replace(/\/+$/, "");
}

// Default timeout (ms) for the model-listing external fetches. Mirrors the
// SHORT_REQUEST_TIMEOUT_MS used by the transcription client so a stalled provider
// endpoint can't pin a worker indefinitely.
const MODELS_FETCH_TIMEOUT_MS = 10_000;

// fetch() with an AbortController timeout. On timeout, surfaces a clear
// "<label> timed out after Ns" error (mirrors fetchWithTimeout in
// transcription-client.ts / the /api/llm-health AbortController pattern).
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (errorName(error) === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The model-list request for a cloud provider: its fixed host and the auth it
 * expects. Also the cheapest call that proves a key still works, which is how
 * the sidebar status probes cloud connections. null for anything else.
 */
export function cloudModelsRequest(provider: string, apiKey: string): { url: string; headers: Record<string, string> } | null {
  switch (provider) {
    case "openai":
      return { url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${apiKey}` } };
    case "anthropic":
      return { url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } };
    case "gemini":
      return { url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`, headers: {} };
    default:
      return null;
  }
}

type ModelsResult =
  | { status: number; body: { error: string } }
  | { status: 200; body: { models: string[]; provider: string } };

// Shared logic for GET/POST /api/models. `keyOverride`/`endpointOverride` let a
// not-yet-saved connection card fetch its models; `connectionId` lets a saved
// card, whose key the client only sees redacted, use its saved key. The key is
// used only as an outbound auth header — it is never logged or echoed back.
export async function listModels(
  provider: string,
  keyOverride: string,
  endpointOverride: string,
  connectionId = ""
): Promise<ModelsResult> {
  const settings = getAllSettings();
  const connections = parseConnections(settings);
  const requestKey = (target: string, endpoint: string) =>
    resolveRequestApiKey({ apiKey: keyOverride, connectionId, provider: target, endpoint }, connections);
  try {
    // ── Cloud providers ────────────────────────────────────────────────────
    if (provider === "openai") {
      const apiKey = requestKey("openai", "") || settings.cloud_api_key_openai || "";
      if (!apiKey) return { status: 400, body: { error: "No OpenAI API key configured" } };
      const request = cloudModelsRequest("openai", apiKey)!;
      const resp = await fetchWithTimeout(request.url, { headers: request.headers }, MODELS_FETCH_TIMEOUT_MS, "OpenAI model list");
      if (!resp.ok) return { status: resp.status, body: { error: `OpenAI returned ${resp.status}` } };
      const models = modelIds((await resp.json()) as ModelListResponse)
        .filter((id) => id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4"))
        .sort();
      return { status: 200, body: { models, provider } };
    }

    if (provider === "anthropic") {
      const apiKey = requestKey("anthropic", "") || settings.cloud_api_key_anthropic || "";
      if (!apiKey) return { status: 400, body: { error: "No Anthropic API key configured" } };
      const request = cloudModelsRequest("anthropic", apiKey)!;
      const resp = await fetchWithTimeout(request.url, { headers: request.headers }, MODELS_FETCH_TIMEOUT_MS, "Anthropic model list");
      if (!resp.ok) return { status: resp.status, body: { error: `Anthropic returned ${resp.status}` } };
      const models = modelIds((await resp.json()) as ModelListResponse).sort();
      return { status: 200, body: { models, provider } };
    }

    if (provider === "gemini") {
      const apiKey = requestKey("gemini", "") || settings.cloud_api_key_gemini || "";
      if (!apiKey) return { status: 400, body: { error: "No Gemini API key configured" } };
      const request = cloudModelsRequest("gemini", apiKey)!;
      const resp = await fetchWithTimeout(request.url, { headers: request.headers }, MODELS_FETCH_TIMEOUT_MS, "Gemini model list");
      if (!resp.ok) return { status: resp.status, body: { error: `Gemini returned ${resp.status}` } };
      const models = modelIds((await resp.json()) as ModelListResponse)
        .map((name) => name.replace(/^models\//, ""))
        .filter((id) => id.startsWith("gemini"))
        .sort();
      return { status: 200, body: { models, provider } };
    }

    // ── Local / OpenAI-compatible endpoint ────────────────────────────────
    const savedEndpoint = (settings.llm_endpoint || "http://localhost:8000/v1").replace(/\/+$/, "");
    let endpoint = savedEndpoint;
    if (endpointOverride) {
      const sanitized = sanitizeLlmEndpoint(endpointOverride);
      if (!sanitized) return { status: 400, body: { error: "Invalid endpoint: must be an http(s) URL" } };
      endpoint = sanitized;
    }
    // The flat api_key was saved for the flat llm_endpoint; any other host gets
    // only the request's key or the key of the saved connection it names.
    const apiKey = requestKey("local", endpoint) || (endpoint === savedEndpoint ? settings.api_key || "" : "");
    const url = endpoint + "/models";
    const resp = await fetchWithTimeout(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }, MODELS_FETCH_TIMEOUT_MS, "LLM model list");
    if (!resp.ok) return { status: resp.status, body: { error: `LLM returned ${resp.status}` } };
    const models = modelIds((await resp.json()) as ModelListResponse);
    return { status: 200, body: { models, provider: "local" } };
  } catch (e) {
    return { status: 500, body: { error: errorMessage(e) || "Failed to list models" } };
  }
}

/** What the model-list endpoints answer: OpenAI's { data: [{ id }] }, Gemini's { models: [{ name }] }, or a bare list. */
interface ModelListResponse {
  data?: unknown;
  models?: unknown;
}

/** The model ids in a model-list response, whichever of the shapes it uses. */
function modelIds(data: ModelListResponse | null | undefined): string[] {
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return list
    .map((entry: unknown) => {
      if (typeof entry === "string") return entry;
      const item = entry as { id?: unknown; name?: unknown } | null;
      return typeof item?.id === "string" ? item.id : typeof item?.name === "string" ? item.name : null;
    })
    .filter((id): id is string => typeof id === "string");
}

export function registerModelsRoutes(app: Express): void {
  app.get("/api/llm-health", async (_req, res) => {
    const settings = getAllSettings();
    const endpoint = (settings.llm_endpoint || "").replace(/\/+$/, "");
    const model = settings.model || "";
    const apiKey = settings.api_key || "";

    if (!endpoint) {
      return res.json({
        ok: false,
        endpointReachable: false,
        modelConfigured: Boolean(model),
        modelAvailable: false,
        reason: "endpoint-missing",
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(`${endpoint}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        return res.json({
          ok: false,
          endpointReachable: false,
          modelConfigured: Boolean(model),
          modelAvailable: false,
          status: resp.status,
          reason: `http-${resp.status}`,
        });
      }

      // The 5s timeout above only covers the headers; a stalled body would
      // hang this route forever, so deadline the JSON read too.
      const bodyTimer = setTimeout(() => controller.abort(), 5000);
      let models: string[];
      try {
        models = modelIds((await resp.json()) as ModelListResponse);
      } finally {
        clearTimeout(bodyTimer);
      }

      const modelConfigured = Boolean(model);
      const modelAvailable = modelConfigured ? models.includes(model) : false;

      return res.json({
        ok: modelConfigured && modelAvailable,
        endpointReachable: true,
        modelConfigured,
        modelAvailable,
        model,
        modelCount: models.length,
        reason: modelConfigured ? (modelAvailable ? "ok" : "model-missing") : "model-not-configured",
      });
    } catch (error) {
      clearTimeout(timeout);
      return res.json({
        ok: false,
        endpointReachable: false,
        modelConfigured: Boolean(model),
        modelAvailable: false,
        reason: errorName(error) === "AbortError" ? "timeout" : "network-error",
        message: errorMessage(error) || "unknown",
      });
    }
  });

  // POST is the preferred path: the API key travels in the request body, never in
  // the URL/query string (which can leak via logs, proxies, Referer headers).
  app.post("/api/models", async (req, res) => {
    const body = (req.body || {}) as { provider?: string; key?: string; endpoint?: string; connectionId?: string };
    const result = await listModels(body.provider || "local", body.key || "", body.endpoint || "", body.connectionId || "");
    res.status(result.status).json(result.body);
  });

  // GET retained for backward-compat. The key may still arrive via query string
  // here; it is used only as an outbound auth header and is never logged.
  app.get("/api/models", async (req, res) => {
    const result = await listModels(
      (req.query.provider as string) || "local",
      (req.query.key as string) || "",
      (req.query.endpoint as string) || "",
      (req.query.connectionId as string) || ""
    );
    res.status(result.status).json(result.body);
  });

  // ======== Test Connection ========
  app.post("/api/test-connection", async (req, res) => {
    const settings = getAllSettings();
    const body = (req.body || {}) as {
      provider?: string;
      apiKey?: string;
      model?: string;
      endpoint?: string;
      connectionId?: string;
    };

    // If the client passes explicit connection fields (e.g. a not-yet-saved
    // connection card), test those. Otherwise test the active connection.
    let conn: { apiKey: string; apiHost: string; model: string; provider?: CloudProvider };
    if (body.provider !== undefined || body.apiKey !== undefined || body.model !== undefined) {
      const provider = body.provider && body.provider !== "local" ? (body.provider as CloudProvider) : undefined;
      const apiHost = body.endpoint || settings.llm_endpoint || "http://localhost:8000/v1";
      const apiKey = resolveRequestApiKey(
        { apiKey: body.apiKey, connectionId: body.connectionId, provider: provider ?? "local", endpoint: apiHost },
        parseConnections(settings),
      );
      conn = { apiKey: apiKey || "", apiHost, model: body.model || "", provider };
    } else {
      const { pool } = resolveConnectionPool(settings);
      const primary = pool[0];
      conn = primary
        ? { apiKey: primary.apiKey, apiHost: primary.apiHost, model: primary.model, provider: primary.provider }
        : { apiKey: settings.api_key || "", apiHost: settings.llm_endpoint || "http://localhost:8000/v1", model: settings.model || "" };
    }

    const result = await testConnection(conn);
    if (result.ok) logger.info("system", `Connection test passed: ${result.message}`);
    else logger.error("system", `Connection test failed: ${result.message}`);
    res.json(result);
  });
}
