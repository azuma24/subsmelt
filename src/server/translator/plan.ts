import type { ResolvedConnection } from "../connections.js";
import type { TypedSettings } from "../settings-schema.js";
import { type ModelContextInfo, planJobContext } from "./context-probe.js";
import type { TranslateFileOptions } from "./engine.js";

/** The translateFile options every caller derives the same way from settings. */
export type PlannedOptions = Required<
  Pick<
    TranslateFileOptions,
    | "connections"
    | "chunkSize"
    | "contextSize"
    | "parallelChunks"
    | "analysisLinesByConnection"
    | "requestTimeoutMs"
    | "temperature"
    | "additional"
    | "disableToolCalls"
    | "refinePass"
  >
>;

export interface TranslationPlan {
  /** Spread into translateFile; the caller adds the file, languages and callbacks. */
  options: PlannedOptions;
  /** What the context probe found for each connection, by id. */
  contexts: ReadonlyMap<string, ModelContextInfo>;
  /** parallel_chunks as configured, before the primary's context window capped it. */
  configuredParallel: number;
}

/**
 * Turns settings and a connection pool into translateFile options. Probes each
 * connection's context window (LM Studio only), so parallel chunks fit the
 * primary and each connection's analysis fits its own window.
 */
export async function planTranslation(
  connections: ResolvedConnection[],
  settings: TypedSettings,
  abortSignal?: AbortSignal,
): Promise<TranslationPlan> {
  if (connections.length === 0) throw new Error("No usable LLM connection configured");
  const chunkSize = settings.chunk_size;
  const configuredParallel = settings.parallel_chunks;
  const probed = await planJobContext(connections, { chunkSize, configuredParallel, abortSignal });
  return {
    options: {
      connections,
      chunkSize,
      contextSize: settings.context_window,
      parallelChunks: probed.parallelChunks,
      analysisLinesByConnection: new Map(
        [...probed.byConnection].map(([id, info]) => [id, info.recommendedAnalysisLines]),
      ),
      requestTimeoutMs: settings.request_timeout_s * 1000,
      temperature: settings.temperature,
      additional: settings.additional_context,
      disableToolCalls: settings.disable_tool_calls,
      refinePass: settings.refine_pass,
    },
    contexts: probed.byConnection,
    configuredParallel,
  };
}
