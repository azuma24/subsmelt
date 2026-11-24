import { Agent } from "undici";

/**
 * Node's fetch gives up on its own after 300 s without response headers, and
 * after 300 s between body chunks, whatever Request timeout is configured.
 * Every LLM request runs under the limits in ai-client, so these are switched
 * off here to let the configured limit be the one that fires.
 */
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** Resolves `globalThis.fetch` per call, so a test that replaces it is still served. */
export const llmFetch: typeof fetch = (input, init) => globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
