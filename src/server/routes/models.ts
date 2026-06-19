import type { Express } from "express";
import { getAllSettings } from "../config.js";
import { testConnection } from "../translator.js";
import { resolveConnectionPool } from "../connections.js";
import type { CloudProvider } from "../translator.js";
import { logger } from "../logger.js";

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
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type ModelsResult =
  | { status: number; body: { error: string } }
  | { status: 200; body: { models: string[]; provider: string } };

// Shared logic for GET/POST /api/models. `keyOverride`/`endpointOverride` let a
// not-yet-saved connection card fetch its models. The key is used only as an
// outbound auth header — it is never logged or echoed back.
async function listModels(
  provider: string,
  keyOverride: string,
  endpointOverride: string
): Promise<ModelsResult> {
  const settings = getAllSettings();
  try {
    // ── Cloud providers ────────────────────────────────────────────────────
    if (provider === "openai") {
      const apiKey = keyOverride || settings.cloud_api_key_openai || "";
      if (!apiKey) return { status: 400, body: { error: "No OpenAI API key configured" } };
      const resp = await fetchWithTimeout("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      }, MODELS_FETCH_TIMEOUT_MS, "OpenAI model list");
      if (!resp.ok) return { status: resp.status, body: { error: `OpenAI returned ${resp.status}` } };
      const data = await resp.json() as any;
      const models: string[] = (data?.data || [])
        .map((m: any) => m.id)
        .filter((id: string) => typeof id === "string" && (
          id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")
        ))
        .sort();
      return { status: 200, body: { models, provider } };
    }

    if (provider === "anthropic") {
      const apiKey = keyOverride || settings.cloud_api_key_anthropic || "";
      if (!apiKey) return { status: 400, body: { error: "No Anthropic API key configured" } };
      const resp = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      }, MODELS_FETCH_TIMEOUT_MS, "Anthropic model list");
      if (!resp.ok) return { status: resp.status, body: { error: `Anthropic returned ${resp.status}` } };
      const data = await resp.json() as any;
      const models: string[] = (data?.data || [])
        .map((m: any) => m.id)
        .filter((id: string) => typeof id === "string")
        .sort();
      return { status: 200, body: { models, provider } };
    }

    if (provider === "gemini") {
      const apiKey = keyOverride || settings.cloud_api_key_gemini || "";
      if (!apiKey) return { status: 400, body: { error: "No Gemini API key configured" } };
      const resp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
        {}, MODELS_FETCH_TIMEOUT_MS, "Gemini model list",
      );
      if (!resp.ok) return { status: resp.status, body: { error: `Gemini returned ${resp.status}` } };
      const data = await resp.json() as any;
      const models: string[] = (data?.models || [])
        .map((m: any) => (m.name || "").replace(/^models\//, ""))
        .filter((id: string) => typeof id === "string" && id.startsWith("gemini"))
        .sort();
      return { status: 200, body: { models, provider } };
    }

    // ── Local / OpenAI-compatible endpoint ────────────────────────────────
    let endpoint: string;
    if (endpointOverride) {
      const sanitized = sanitizeLlmEndpoint(endpointOverride);
      if (!sanitized) return { status: 400, body: { error: "Invalid endpoint: must be an http(s) URL" } };
      endpoint = sanitized;
    } else {
      endpoint = (settings.llm_endpoint || "http://localhost:8000/v1").replace(/\/+$/, "");
    }
    const apiKey = keyOverride || settings.api_key || "";
    const url = endpoint + "/models";
    const resp = await fetchWithTimeout(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }, MODELS_FETCH_TIMEOUT_MS, "LLM model list");
    if (!resp.ok) return { status: resp.status, body: { error: `LLM returned ${resp.status}` } };
    const data = await resp.json() as any;
    const models: string[] = (data?.data || data?.models || [])
      .map((m: any) => m.id || m.name || m)
      .filter((m: any) => typeof m === "string");
    return { status: 200, body: { models, provider: "local" } };
  } catch (e: any) {
    return { status: 500, body: { error: e?.message || "Failed to list models" } };
  }
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

      const data = await resp.json() as any;
      const models: string[] = (data?.data || data?.models || [])
        .map((m: any) => m.id || m.name || m)
        .filter((m: any) => typeof m === "string");

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
    } catch (error: any) {
      clearTimeout(timeout);
      return res.json({
        ok: false,
        endpointReachable: false,
        modelConfigured: Boolean(model),
        modelAvailable: false,
        reason: error?.name === "AbortError" ? "timeout" : "network-error",
        message: error?.message || "unknown",
      });
    }
  });

  // POST is the preferred path: the API key travels in the request body, never in
  // the URL/query string (which can leak via logs, proxies, Referer headers).
  app.post("/api/models", async (req, res) => {
    const body = (req.body || {}) as { provider?: string; key?: string; endpoint?: string };
    const result = await listModels(body.provider || "local", body.key || "", body.endpoint || "");
    res.status(result.status).json(result.body);
  });

  // GET retained for backward-compat. The key may still arrive via query string
  // here; it is used only as an outbound auth header and is never logged.
  app.get("/api/models", async (req, res) => {
    const result = await listModels(
      (req.query.provider as string) || "local",
      (req.query.key as string) || "",
      (req.query.endpoint as string) || ""
    );
    res.status(result.status).json(result.body);
  });

  // ======== Test Connection ========
  app.post("/api/test-connection", async (req, res) => {
    const settings = getAllSettings();
    const body = (req.body || {}) as { provider?: string; apiKey?: string; model?: string; endpoint?: string };

    // If the client passes explicit connection fields (e.g. a not-yet-saved
    // connection card), test those. Otherwise test the active connection.
    let conn: { apiKey: string; apiHost: string; model: string; provider?: CloudProvider };
    if (body.provider !== undefined || body.apiKey !== undefined || body.model !== undefined) {
      conn = {
        apiKey: body.apiKey || "",
        apiHost: body.endpoint || settings.llm_endpoint || "http://localhost:8000/v1",
        model: body.model || "",
        provider: body.provider && body.provider !== "local" ? (body.provider as CloudProvider) : undefined,
      };
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
