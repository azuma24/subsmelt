import type { ResolvedConnection } from "../connections.js";
import type { UsageKind } from "../../shared/usage.js";
import { errorMessage } from "../errors.js";
import { serverOf } from "../machine.js";
import type { TokenUsage } from "./ai-client.js";
import { retryTranslate, translateChunk, translateSingle } from "./ai-client.js";
import type { ConnectionHealth } from "./connection-health.js";
import { ContextOverflowError } from "./context-overflow.js";
import { SINGLE_LINE_RETRIES } from "./fallback-policy.js";

/** Per-attempt controls; an attempt of a chunk being raced has its own signal. */
export interface ChunkCallHooks {
  signal?: AbortSignal;
  /** Connections this attempt must leave alone. */
  skip?: (conn: ResolvedConnection) => boolean;
  /** Fired as the attempt reaches each connection. */
  onConnection?: (conn: ResolvedConnection) => void;
}

export interface ChunkTranslatorDeps {
  health: Pick<ConnectionHealth, "live" | "noteFailure" | "withConnection">;
  jobSignal: AbortSignal;
  systemPrompt: string;
  temperature: number;
  disableToolCalls?: boolean;
  chunkTimeoutMs?: number;
  singleLineTimeoutMs: number;
  markUsed: (conn: ResolvedConnection) => void;
  usageFor: (kind: UsageKind, conn: ResolvedConnection) => ((usage: TokenUsage) => void) | undefined;
  onRetry?: (attempt: number, error: unknown, backoff: number, maxRetries?: number) => void;
  onConnectionError?: (info: { id: string; label: string; error: string }) => void;
}

const isAbort = (error: unknown) => {
  const message = errorMessage(error);
  return message === "STOP_REQUESTED" || message === "JOB_CANCELLED";
};

/** The LLM calls of the chunk pass and the per-line fallback, each cascading through a connection order. */
export function createChunkTranslator(deps: ChunkTranslatorDeps) {
  const { health, jobSignal } = deps;

  // Chunk requests in flight per server. Servers like LM Studio share one
  // context window across concurrent requests, so an overflow on a server that
  // was also serving a sibling means "too many at once", not "too big".
  const chunksInFlight = new Map<string, number>();

  function reportFailure(conn: ResolvedConnection, error: unknown) {
    health.noteFailure(conn, error);
    deps.onConnectionError?.({ id: conn.id, label: conn.label, error: String(errorMessage(error) || error) });
  }

  return {
    async translateChunkWithFallback(
      coreText: string[],
      order: ResolvedConnection[],
      contextPromptPrefix: string,
      hooks: ChunkCallHooks = {},
    ): Promise<{ result: string[]; conn: ResolvedConnection } | null> {
      const usable = health.live(order);
      if (usable.length === 0) {
        throw new Error("All LLM connections timed out repeatedly — aborting job");
      }
      for (const conn of usable) {
        if (hooks.skip?.(conn)) continue;
        hooks.onConnection?.(conn);
        const signal = hooks.signal ?? jobSignal;
        let sharedServer = false;
        try {
          const result = await health.withConnection(
            conn,
            () =>
              retryTranslate(
                (attempt) => {
                  const temperature = Math.max(
                    0.1,
                    Math.min(2, deps.temperature + (attempt - 1) * 0.15 + (Math.random() - 0.5) * 0.1),
                  );
                  const server = serverOf(conn);
                  const inFlight = (chunksInFlight.get(server) ?? 0) + 1;
                  chunksInFlight.set(server, inFlight);
                  sharedServer = inFlight > 1;
                  return translateChunk(coreText, {
                    apiKey: conn.apiKey,
                    apiHost: conn.apiHost,
                    model: conn.model,
                    provider: conn.provider,
                    systemPrompt: deps.systemPrompt,
                    temperature,
                    abortSignal: signal,
                    disableToolCalls: deps.disableToolCalls,
                    requestTimeoutMs: deps.chunkTimeoutMs,
                    contextPromptPrefix,
                    onUsage: deps.usageFor("chunk", conn),
                  })
                    .then((result) => {
                      if (!Array.isArray(result) || result.length !== coreText.length) {
                        throw new Error("did not match schema");
                      }
                      return result;
                    })
                    .finally(() => {
                      chunksInFlight.set(server, (chunksInFlight.get(server) ?? 1) - 1);
                    });
                },
                2,
                1000,
                deps.onRetry,
                signal,
              ),
            signal,
          );
          deps.markUsed(conn);
          return { result, conn };
        } catch (error) {
          if (isAbort(error)) throw error;
          // Retried later at lower concurrency (see processChunk).
          if (sharedServer && error instanceof ContextOverflowError) throw error;
          // exhausted retries on this connection — cascade to the next
          reportFailure(conn, error);
        }
      }
      return null;
    },

    async translateSingleWithFallback(
      lineText: string,
      order: ResolvedConnection[],
      signal: AbortSignal = jobSignal,
    ): Promise<string> {
      let lastError: unknown;
      const usable = health.live(order);
      if (usable.length === 0) {
        throw new Error("All LLM connections timed out repeatedly — aborting job");
      }
      for (const conn of usable) {
        try {
          const result = await health.withConnection(
            conn,
            () =>
              retryTranslate(
                () =>
                  translateSingle(lineText, {
                    apiKey: conn.apiKey,
                    apiHost: conn.apiHost,
                    model: conn.model,
                    provider: conn.provider,
                    systemPrompt: deps.systemPrompt,
                    temperature: deps.temperature,
                    abortSignal: signal,
                    disableToolCalls: deps.disableToolCalls,
                    requestTimeoutMs: deps.singleLineTimeoutMs,
                    onUsage: deps.usageFor("single", conn),
                  }),
                SINGLE_LINE_RETRIES,
                1000,
                deps.onRetry,
                signal,
              ),
            signal,
          );
          deps.markUsed(conn);
          return result;
        } catch (error) {
          if (isAbort(error)) throw error;
          lastError = error;
          reportFailure(conn, error);
        }
      }
      throw lastError || new Error("All LLM connections failed");
    },
  };
}
