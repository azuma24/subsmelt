import { sanitizeSecrets, toSnippet, tryJsonParse } from "./utils.js";

// ── Error diagnostics ─────────────────────────────────────────────────────────

export interface TranslationErrorDiagnostics {
  message: string;
  status?: number;
  code?: string;
  causeMessage?: string;
  responseSnippet?: string;
}

export function summarizeTranslationError(error: unknown): TranslationErrorDiagnostics {
  const err = error as any;
  const status: number | undefined =
    typeof err?.status === "number"
      ? err.status
      : typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.response?.status === "number"
      ? err.response.status
      : undefined;

  const code = typeof err?.code === "string" ? err.code : undefined;

  const causeMessage =
    typeof err?.cause?.message === "string"
      ? sanitizeSecrets(err.cause.message)
      : undefined;

  const responseBodyRaw =
    err?.responseBody ?? err?.response?.body ?? err?.body ?? err?.data ?? err?.cause?.responseBody;

  const parsed =
    typeof responseBodyRaw === "string" ? tryJsonParse(responseBodyRaw) ?? responseBodyRaw : responseBodyRaw;
  const responseSnippet = toSnippet(parsed);

  // Build the most informative message possible — AI SDK APICallError often has
  // empty .message when LM Studio returns HTTP errors with empty body or
  // {"error":{"message":""}}. Fall through a chain of richer fields.
  let baseMessage: string;
  if (typeof err?.message === "string" && err.message.trim().length > 0) {
    baseMessage = sanitizeSecrets(err.message.trim());
  } else if (causeMessage && causeMessage.trim().length > 0) {
    baseMessage = `Connection error: ${causeMessage}`;
  } else {
    const bodyMsg = extractErrorMessageFromBody(parsed);
    if (bodyMsg) {
      baseMessage = sanitizeSecrets(bodyMsg);
    } else if (responseBodyRaw) {
      baseMessage = status
        ? `HTTP ${status} error (empty/unparseable response body)`
        : "Empty error response from LLM server";
    } else if (status) {
      baseMessage = `HTTP ${status} error from LLM server (no body)`;
    } else if (typeof err?.name === "string" && err.name !== "Error") {
      baseMessage = `LLM error: ${err.name}`;
    } else if (typeof error === "string" && (error as string).trim()) {
      baseMessage = sanitizeSecrets((error as string).trim());
    } else {
      baseMessage = "Unknown translation error";
    }
  }

  const parts = [
    status ? `HTTP ${status}` : null,
    code ? `code=${code}` : null,
    baseMessage,
  ].filter(Boolean);

  return {
    message: parts.join(" | "),
    status,
    code,
    causeMessage,
    responseSnippet,
  };
}

/** Extract a human-readable message from a parsed API error body. */
function extractErrorMessageFromBody(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") {
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim().slice(0, 300);
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  // OpenAI-style: { error: { message: "..." } }
  if (obj.error && typeof obj.error === "object") {
    const errObj = obj.error as Record<string, unknown>;
    if (typeof errObj.message === "string" && errObj.message.trim())
      return errObj.message.trim().slice(0, 300);
    if (typeof errObj.type === "string" && errObj.type.trim())
      return `error type: ${errObj.type.trim()}`;
  }
  // Flat: { message: "..." }
  if (typeof obj.message === "string" && obj.message.trim())
    return obj.message.trim().slice(0, 300);
  // FastAPI-style: { detail: "..." }
  if (typeof obj.detail === "string" && obj.detail.trim())
    return obj.detail.trim().slice(0, 300);
  return null;
}
