import { sanitizeSecrets, toSnippet, tryJsonParse } from "./utils.js";
import { errorCauseMessage, errorName, errorStatus } from "../errors.js";

// ── Error diagnostics ─────────────────────────────────────────────────────────

export interface TranslationErrorDiagnostics {
  message: string;
  status?: number;
  code?: string;
  causeMessage?: string;
  responseSnippet?: string;
}

/** The fields an SDK or fetch error may carry; every read below checks the type. */
interface ErrorShape {
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown; body?: unknown } | null;
  code?: unknown;
  cause?: { message?: unknown; responseBody?: unknown } | null;
  responseBody?: unknown;
  body?: unknown;
  data?: unknown;
  message?: unknown;
  name?: unknown;
}

export function summarizeTranslationError(error: unknown): TranslationErrorDiagnostics {
  const err = (error !== null && typeof error === "object" ? error : null) as ErrorShape | null;
  const status = errorStatus(error);
  const code = typeof err?.code === "string" ? err.code : undefined;
  const causeMessage = errorCauseMessage(error);
  const sanitizedCause = causeMessage ? sanitizeSecrets(causeMessage) : undefined;

  const responseBodyRaw =
    err?.responseBody ?? err?.response?.body ?? err?.body ?? err?.data ?? err?.cause?.responseBody;

  const parsed =
    typeof responseBodyRaw === "string" ? tryJsonParse(responseBodyRaw) ?? responseBodyRaw : responseBodyRaw;
  const responseSnippet = toSnippet(parsed);

  // Build the most informative message possible — AI SDK APICallError often has
  // empty .message when LM Studio returns HTTP errors with empty body or
  // {"error":{"message":""}}. Fall through a chain of richer fields.
  const ownMessage = typeof err?.message === "string" ? err.message.trim() : "";
  const name = errorName(error);
  let baseMessage: string;
  if (ownMessage.length > 0) {
    baseMessage = sanitizeSecrets(ownMessage);
  } else if (sanitizedCause && sanitizedCause.trim().length > 0) {
    baseMessage = `Connection error: ${sanitizedCause}`;
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
    } else if (name && name !== "Error") {
      baseMessage = `LLM error: ${name}`;
    } else if (typeof error === "string" && error.trim()) {
      baseMessage = sanitizeSecrets(error.trim());
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
    causeMessage: sanitizedCause,
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
