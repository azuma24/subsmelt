import { errorMessage } from "../errors.js";
/**
 * A request the model server rejected because it did not fit the context window.
 *
 * Servers report this as an ordinary 4xx/5xx whose message is just "Bad Request";
 * the reason lives in the response body. Recognising it lets callers shrink the
 * request or its concurrency instead of retrying the same overflow or treating
 * the endpoint as broken.
 */
export class ContextOverflowError extends Error {
  /** The server's context window in tokens, when the error reports it. */
  readonly contextTokens: number | null;

  constructor(contextTokens: number | null, detail: string) {
    const size = contextTokens ? ` (${contextTokens} tokens)` : "";
    super(`Context window exceeded${size}: ${detail}`);
    this.name = "ContextOverflowError";
    this.contextTokens = contextTokens;
  }
}

const OVERFLOW_MARKERS = [
  // llama.cpp / LM Studio: one request larger than the loaded context.
  "exceed_context_size_error",
  "exceeds the available context size",
  // llama.cpp / LM Studio: concurrent requests filled the shared context.
  "context size has been exceeded",
  // OpenAI, vLLM and most OpenAI-compatible servers.
  "context_length_exceeded",
  "maximum context length",
  // Anthropic.
  "prompt is too long",
  // Gemini.
  "exceeds the maximum number of tokens",
];

const CONTEXT_SIZE_PATTERNS = [
  /n_ctx\\*"?\s*:\s*(\d+)/,
  /available context size \((\d+) tokens\)/,
  /maximum context length is (\d+)/,
  /maximum number of tokens allowed \((\d+)\)/,
];

/** The error as a {@link ContextOverflowError}, or null when it is something else. */
export function toContextOverflow(error: unknown): ContextOverflowError | null {
  if (error instanceof ContextOverflowError) return error;
  const err = error as { message?: unknown; responseBody?: unknown } | null;
  const text = `${String(errorMessage(err) ?? "")} ${String(err?.responseBody ?? "")}`;
  const lower = text.toLowerCase();
  const marker = OVERFLOW_MARKERS.find((m) => lower.includes(m));
  if (!marker) return null;

  let contextTokens: number | null = null;
  for (const pattern of CONTEXT_SIZE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      contextTokens = Number(match[1]);
      break;
    }
  }
  return new ContextOverflowError(contextTokens, marker.replace(/_/g, " "));
}
