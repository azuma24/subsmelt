import type { ResolvedConnection } from "../connections.js";
import type { UsageKind } from "../../shared/usage.js";
import { errorMessage } from "../errors.js";
import { serverOf } from "../machine.js";
import {
  InvalidChunkTranslationError,
  type TokenUsage,
  retryTranslate,
  translateChunk,
  translateSingle,
} from "./ai-client.js";
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
  chunkSize: number;
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
  const batchLimits = new Map<string, { size: number; failures: number }>();
  const minimumBatchSize = Math.ceil(deps.chunkSize / 4);

  function reduceBatchAfterFailure(connectionId: string, attemptedSize: number): number | undefined {
    const batch = batchLimits.get(connectionId) ?? { size: deps.chunkSize, failures: 0 };
    // Ignore shorter tail batches and requests started before a reduction.
    if (batch.size !== attemptedSize || batch.size <= minimumBatchSize) return;
    batch.failures += 1;
    batchLimits.set(connectionId, batch);
    if (batch.failures < 2) return;
    batch.size = Math.max(minimumBatchSize, Math.ceil(batch.size / 2));
    batch.failures = 0;
    return batch.size;
  }

  function reportFailure(conn: ResolvedConnection, error: unknown, attemptedSize = 0) {
    health.noteFailure(conn, error);
    let message = String(errorMessage(error) || error);
    if (error instanceof InvalidChunkTranslationError) {
      const reducedSize = reduceBatchAfterFailure(conn.id, attemptedSize);
      if (reducedSize !== undefined) {
        message += `. Future batches on this connection will use up to ${reducedSize} cues per request`;
      }
    }
    deps.onConnectionError?.({ id: conn.id, label: conn.label, error: message });
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
        const server = serverOf(conn);
        let sharedServer = false;
        let attemptedSize = 0;

        function requestBatch(cues: string[], attempt: number) {
          const temperature = Math.max(
            0.1,
            Math.min(2, deps.temperature + (attempt - 1) * 0.15 + (Math.random() - 0.5) * 0.1),
          );
          const inFlight = (chunksInFlight.get(server) ?? 0) + 1;
          chunksInFlight.set(server, inFlight);
          sharedServer = inFlight > 1;
          return translateChunk(cues, {
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
          }).finally(() => {
            chunksInFlight.set(server, (chunksInFlight.get(server) ?? 1) - 1);
          });
        }

        async function translateBatches() {
          const translations: string[] = [];
          while (translations.length < coreText.length) {
            const size = batchLimits.get(conn.id)?.size ?? deps.chunkSize;
            const cues = coreText.slice(translations.length, translations.length + size);
            attemptedSize = cues.length;
            const batch = await retryTranslate((attempt) => requestBatch(cues, attempt), 2, 1000, deps.onRetry, signal);
            const limit = batchLimits.get(conn.id);
            if (limit?.size === attemptedSize) limit.failures = 0;
            translations.push(...batch);
          }
          return translations;
        }

        try {
          const result = await health.withConnection(conn, translateBatches, signal);
          deps.markUsed(conn);
          return { result, conn };
        } catch (error) {
          if (isAbort(error)) throw error;
          // Retried later at lower concurrency (see processChunk).
          if (sharedServer && error instanceof ContextOverflowError) throw error;
          reportFailure(conn, error, attemptedSize);
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
