import fs from "node:fs";
import path from "node:path";
import type { LlmMode, ResolvedConnection } from "../connections.js";
import type { CloudProvider } from "./ai-client.js";
import {
  retryTranslate,
  translateChunk,
  translateSingle,
} from "./ai-client.js";
import {
  parseSubtitle,
  saveTranslated,
  splitIntoChunks,
  sanitizeSecrets,
  toSnippet,
  tryJsonParse,
  type SubtitleCue,
} from "./utils.js";
import { buildTranslationSystemPrompt } from "./prompt.js";
import { refineChunk } from "./prompt.js";
import {
  analyzeSubtitlesForContext,
  buildChunkGlossaryBlock,
  buildSeriesGlossarySeed,
  loadSeriesGlossary,
  mergeSeriesGlossary,
  parseGlossaryFromAnalysis,
  scanForGlossaryTerms,
  type GlossaryEntry,
  type SeriesGlossary,
} from "./context.js";

// ── Dynamic model context probing ────────────────────────────────────────────

export interface ModelContextInfo {
  /** Maximum context window in tokens, or null if unknown */
  maxContextTokens: number | null;
  /** Recommended parallel chunks based on context size */
  recommendedParallelChunks: number;
  /** Recommended max lines for context analysis */
  recommendedAnalysisLines: number;
}

/**
 * Probe the LM Studio native API (/api/v0/models) to get the active model's
 * context window size, then derive safe defaults for analysis line cap and
 * parallel chunk count.
 *
 * Falls back gracefully if the endpoint isn't LM Studio or the call fails —
 * returns conservative defaults so any OpenAI-compatible host works.
 */
export async function probeModelContext(
  apiHost: string,
  model: string,
  chunkSize = 20
): Promise<ModelContextInfo> {
  const FALLBACK: ModelContextInfo = {
    maxContextTokens: null,
    recommendedParallelChunks: 1,
    recommendedAnalysisLines: 2000,
  };

  try {
    // Strip /v1 or trailing path — LM Studio native API is at the root
    const base = apiHost.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    const url = `${base}/api/v0/models`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return FALLBACK;

    const json = (await resp.json()) as { data?: Array<{ id: string; max_context_length?: number }> };
    const models = json?.data ?? [];
    if (models.length === 0) return FALLBACK;

    // Find the configured model by ID (case-insensitive prefix match)
    const modelLower = model.toLowerCase();
    const match =
      models.find((m) => m.id.toLowerCase() === modelLower) ??
      models.find((m) => m.id.toLowerCase().includes(modelLower.split("/").pop() ?? modelLower)) ??
      models[0]; // fallback: first loaded model

    const maxCtx = match?.max_context_length ?? null;
    if (!maxCtx) return FALLBACK;

    // Analysis lines: use up to 25% of context for the analysis prompt.
    // Rough estimate: 1 subtitle line ≈ 60 chars ≈ 15 tokens.
    // Leave ~20% headroom for system prompt + response.
    const tokensForAnalysis = Math.floor(maxCtx * 0.20);
    const tokensPerLine = 15;
    const recommendedAnalysisLines = Math.max(
      200,
      Math.min(5000, Math.floor(tokensForAnalysis / tokensPerLine))
    );

    // Parallel chunks: how many chunk-sized windows fit in 40% of context.
    // Each chunk = chunkSize cues × ~30 tokens per cue (input + output buffer).
    // Cap at 2 — beyond that, parallel requests on a single GPU thrash memory
    // and cause timeouts faster than they save time.
    const tokensPerChunk = chunkSize * 30;
    const tokensForParallel = Math.floor(maxCtx * 0.40);
    const recommendedParallelChunks = Math.max(
      1,
      Math.min(2, Math.floor(tokensForParallel / tokensPerChunk))
    );

    return { maxContextTokens: maxCtx, recommendedParallelChunks, recommendedAnalysisLines };
  } catch {
    return FALLBACK;
  }
}

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

// ── Core translation loop ─────────────────────────────────────────────────────

export interface TranslateFileOptions {
  srtPath: string;
  outputPath: string;
  apiKey: string;
  apiHost: string;
  model: string;
  /** Cloud provider to use. When set, overrides the local endpoint with the provider's native SDK. */
  provider?: CloudProvider;
  prompt: string;
  lang: string;
  sourceLang?: string;
  additional: string;
  temperature: number;
  chunkSize: number;
  contextSize: number;
  parallelChunks: number;
  /** Dynamic analysis line cap from probeModelContext(). Falls back to 2000. */
  maxAnalysisLines?: number;
  /** Per-job request timeout in ms. Overrides the module default (300s). */
  requestTimeoutMs?: number;
  onProgress?: (completed: number, total: number) => void;
  onRetry?: (attempt: number, error: unknown, backoff: number) => void;
  onAnalysis?: (analysis: string) => void;
  abortSignal?: AbortSignal;
  disableToolCalls?: boolean;
  /**
   * Refinement Pass (Pass 2). When true, each translated chunk is sent back to
   * the LLM for an editing pass that polishes flow/tone. Purely additive: a
   * refined chunk is accepted only if it returns the exact same line count,
   * otherwise the original pass-1 translation is kept. Default false.
   */
  refinePass?: boolean;
  /**
   * Series-Wide Memory (§2). When true, a `.subsmelt_glossary.json` file in the
   * translated file's own folder is loaded before analysis (seeding the context
   * with prior files' terms) and updated after analysis with newly-extracted
   * glossary terms. Purely additive: when false, behavior is unchanged and the
   * file is never read or written. Default false.
   */
  seriesMemory?: boolean;
  /**
   * Multi-connection pool. When provided (length ≥ 1) this overrides the single
   * apiKey/apiHost/model/provider fields. The first entry is the primary.
   */
  connections?: ResolvedConnection[];
  /** single | fallback | parallel. Defaults to "single". */
  llmMode?: LlmMode;
  /** Fired once per connection the moment it first produces a translation. */
  onConnectionUsed?: (info: { id: string; label: string }) => void;
  /** Fired when a connection exhausts its retries and the job cascades to the next. */
  onConnectionError?: (info: { id: string; label: string; error: string }) => void;
}

export async function translateFile(opts: TranslateFileOptions): Promise<void> {
  const sourceExt = path.extname(opts.srtPath).slice(1).toLowerCase();
  const outputExt = path.extname(opts.outputPath).slice(1).toLowerCase() || sourceExt;
  const content = fs.readFileSync(opts.srtPath, "utf8");
  const parsed = parseSubtitle(content, sourceExt);
  // Use per-job timeout if provided, otherwise fall back to module default
  const jobTimeoutMs = opts.requestTimeoutMs;

  // Resolve the connection pool. Falls back to the single legacy fields so
  // existing callers (and single mode) behave exactly as before.
  const connections: ResolvedConnection[] = (opts.connections && opts.connections.length > 0)
    ? opts.connections
    : [{ id: "default", label: "default", apiKey: opts.apiKey, apiHost: opts.apiHost, model: opts.model, provider: opts.provider }];
  const llmMode: LlmMode = opts.llmMode || "single";
  const primary = connections[0];
  const usedConnIds = new Set<string>();
  const markUsed = (c: ResolvedConnection) => {
    if (usedConnIds.has(c.id)) return;
    usedConnIds.add(c.id);
    opts.onConnectionUsed?.({ id: c.id, label: c.label });
  };

  let subtitle: SubtitleCue[];
  if (Array.isArray(parsed)) {
    subtitle = (parsed as SubtitleCue[]).filter((line) => line.type === "cue");
  } else if ((parsed as { events?: SubtitleCue[] }).events) {
    subtitle = (parsed as { events: SubtitleCue[] }).events;
  } else {
    subtitle = parsed as unknown as SubtitleCue[];
  }

  const totalCues = subtitle.length;
  if (totalCues === 0) throw new Error("No subtitle cues found");

  opts.onProgress?.(0, totalCues);

  const allTexts = subtitle
    .map((cue: SubtitleCue) => (cue?.data ? String(cue.data.text || "") : ""))
    .map((text: string) => text.replace(/\n/g, " ").trim())
    .filter((text: string) => text.length > 0);

  let effectiveAdditional = opts.additional;

  // Series-Wide Memory (§2) — seed the context with prior files' glossary terms
  // from this folder's .subsmelt_glossary.json. Best-effort: a missing/corrupt
  // file simply yields no seed. Only active when seriesMemory is enabled.
  let seriesGlossary: SeriesGlossary | null = null;
  if (opts.seriesMemory) {
    seriesGlossary = loadSeriesGlossary(opts.srtPath);
    const seed = buildSeriesGlossarySeed(seriesGlossary);
    if (seed) {
      effectiveAdditional = `${effectiveAdditional ? `${effectiveAdditional}\n\n` : ""}${seed}`;
    }
  }

  // Context analysis runs for every file regardless of length — short clips
  // (tech talks, interviews) still carry glossary-worthy terms worth pinning.
  const analysis = await analyzeSubtitlesForContext(allTexts, {
    apiKey: primary.apiKey,
    apiHost: primary.apiHost,
    model: primary.model,
    provider: primary.provider,
    lang: opts.lang,
    temperature: 0.3,
    abortSignal: opts.abortSignal,
    maxAnalysisLines: opts.maxAnalysisLines,
    requestTimeoutMs: jobTimeoutMs,
  });

  if (analysis) {
    effectiveAdditional = `${effectiveAdditional ? `${effectiveAdditional}\n\n` : ""}[Context]\n${analysis}`;
    opts.onAnalysis?.(analysis);
  }

  // Active Glossary Injection (§1) — parse the analysis blob into structured
  // {term, translation} pairs once, then merge the series glossary on top so
  // every known term is available for per-chunk scanning. Purely additive: if
  // nothing parses, this is an empty list and chunk prompts are unchanged.
  const parsedGlossary = parseGlossaryFromAnalysis(analysis);
  const glossaryByTerm = new Map<string, GlossaryEntry>();
  for (const e of parsedGlossary) glossaryByTerm.set(e.term.toLowerCase(), e);
  if (seriesGlossary) {
    for (const [term, translation] of Object.entries(seriesGlossary.terms)) {
      const key = term.toLowerCase();
      if (term.trim() && translation.trim() && !glossaryByTerm.has(key)) {
        glossaryByTerm.set(key, { term, translation });
      }
    }
  }
  const chunkGlossary: GlossaryEntry[] = Array.from(glossaryByTerm.values());

  // Series-Wide Memory (§2) — merge newly-extracted terms back into the series
  // file so the next file in this folder inherits them. Best-effort, never fatal.
  if (opts.seriesMemory && parsedGlossary.length > 0) {
    mergeSeriesGlossary(opts.srtPath, parsedGlossary);
  }

  const systemPrompt = buildTranslationSystemPrompt({
    prompt: opts.prompt,
    lang: opts.lang,
    sourceLang: opts.sourceLang,
    additional: effectiveAdditional,
  });

  const indexMap = new Map<SubtitleCue, number>();
  subtitle.forEach((cue, idx) => indexMap.set(cue, idx));

  // ── Multi-connection helpers ────────────────────────────────────────────
  // In parallel mode each worker is assigned a primary connection (round-robin
  // by index); the remaining connections act as per-chunk fallbacks. In single
  // and fallback modes the connections are tried in their listed order.
  function connectionOrderFor(workerIndex: number): ResolvedConnection[] {
    if (llmMode !== "parallel" || connections.length <= 1) return connections;
    const primaryIdx = workerIndex % connections.length;
    return [connections[primaryIdx], ...connections.filter((_, i) => i !== primaryIdx)];
  }

  async function translateChunkWithFallback(
    coreText: string[],
    order: ResolvedConnection[],
    contextPromptPrefix: string
  ): Promise<{ result: string[]; conn: ResolvedConnection } | null> {
    for (const conn of order) {
      try {
        const result = await retryTranslate(
          (attempt) => {
            const attemptTemp = Math.max(
              0.1,
              Math.min(2, opts.temperature + (attempt - 1) * 0.15 + (Math.random() - 0.5) * 0.1)
            );
            return translateChunk(coreText, {
              apiKey: conn.apiKey,
              apiHost: conn.apiHost,
              model: conn.model,
              provider: conn.provider,
              systemPrompt,
              temperature: attemptTemp,
              abortSignal: opts.abortSignal,
              disableToolCalls: opts.disableToolCalls,
              requestTimeoutMs: jobTimeoutMs,
              contextPromptPrefix,
            }).then((r) => {
              if (!Array.isArray(r) || r.length !== coreText.length) {
                throw new Error("did not match schema");
              }
              return r;
            });
          },
          2,
          1000,
          opts.onRetry
        );
        markUsed(conn);
        return { result, conn };
      } catch (e: any) {
        if (e?.message === "STOP_REQUESTED") throw e;
        // exhausted retries on this connection — cascade to the next
        opts.onConnectionError?.({ id: conn.id, label: conn.label, error: String(e?.message || e) });
      }
    }
    return null;
  }

  async function translateSingleWithFallback(
    lineText: string,
    order: ResolvedConnection[],
    retries = 3
  ): Promise<string> {
    let lastErr: unknown;
    for (const conn of order) {
      try {
        const r = await retryTranslate(
          (_) =>
            translateSingle(lineText, {
              apiKey: conn.apiKey,
              apiHost: conn.apiHost,
              model: conn.model,
              provider: conn.provider,
              systemPrompt,
              temperature: opts.temperature,
              abortSignal: opts.abortSignal,
              disableToolCalls: opts.disableToolCalls,
              requestTimeoutMs: jobTimeoutMs,
            }),
          retries,
          1000,
          opts.onRetry
        );
        markUsed(conn);
        return r;
      } catch (e: any) {
        if (e?.message === "STOP_REQUESTED") throw e;
        lastErr = e;
        opts.onConnectionError?.({ id: conn.id, label: conn.label, error: String(e?.message || e) });
      }
    }
    throw lastErr || new Error("All LLM connections failed");
  }

  const chunks = splitIntoChunks(subtitle, opts.chunkSize);
  let completedCues = 0;
  const contextSize = opts.contextSize;
  const configuredConcurrency = Math.max(1, Math.min(8, opts.parallelChunks || 1));
  // In parallel mode, ensure enough workers to actually exercise every connection.
  // Connection-driven concurrency may exceed the single-endpoint parallel_chunks
  // cap (8): each extra connection is a separate backend, so workers scale up to
  // MAX_PARALLEL_CONNECTIONS distinct primaries.
  const MAX_PARALLEL_CONNECTIONS = 32;
  const concurrency = llmMode === "parallel"
    ? Math.max(1, Math.min(MAX_PARALLEL_CONNECTIONS, Math.max(configuredConcurrency, connections.length)))
    : configuredConcurrency;

  // Concurrency-limited chunk processor.
  // Each slot processes chunks from the shared queue independently.
  // Progress and partial saves are guarded by a simple mutex flag.
  const chunkQueue = [...chunks];
  // Promise-chain mutex: each save is serialized by chaining onto the previous one.
  // Using a flag is NOT safe — two workers can both read `saving === false` before
  // either sets it to true (both pass the check in the same microtask tick).
  let saveChain = Promise.resolve();

  async function processChunk(block: SubtitleCue[], workerIndex: number) {
    const coreIndices = block
      .map((cue: SubtitleCue) => indexMap.get(cue) as number)
      .filter((n: number) => typeof n === "number")
      .sort((a: number, b: number) => a - b);

    if (coreIndices.length === 0) return;

    const coreStart = coreIndices[0];
    const coreEnd = coreIndices[coreIndices.length - 1];
    const contextStart = Math.max(0, coreStart - contextSize);
    const contextEnd = Math.min(subtitle.length - 1, coreEnd + contextSize);

    let translatedWindow: string[] | null = null;

    // Build separate context prefix and core-only payload.
    // Previously we sent the full window (core + context padding) and asked the
    // model to translate ALL of it, then validated result.length === windowText.length.
    // This caused systematic "did not match schema" failures because thinking models
    // sometimes only translated the core lines (the right thing to do).
    //
    // New approach: send context lines as read-only "preceding/following context"
    // in the prompt, send only core lines as the translation target.
    // Validation is now against coreText.length (always stable).
    const contextBefore = subtitle.slice(contextStart, coreStart)
      .map((c: SubtitleCue) => c?.data ? String(c.data.text).replace(/\n/g, " ").trim() : "");
    const contextAfter = subtitle.slice(coreEnd + 1, contextEnd + 1)
      .map((c: SubtitleCue) => c?.data ? String(c.data.text).replace(/\n/g, " ").trim() : "");
    const coreText = subtitle.slice(coreStart, coreEnd + 1)
      .map((c: SubtitleCue) => c?.data ? String(c.data.text).replace(/\n/g, " ").trim() : "");

    // Build context-aware prompt prefix
    let contextPromptPrefix = "";
    if (contextBefore.length > 0) {
      contextPromptPrefix += `[Preceding context — DO NOT translate these]\n${contextBefore.join("\n")}\n\n`;
    }
    if (contextAfter.length > 0) {
      contextPromptPrefix += `[Following context — DO NOT translate these]\n${contextAfter.join("\n")}\n\n`;
    }
    if (contextPromptPrefix) {
      contextPromptPrefix += "[Translate ONLY the lines below]\n";
    }

    // Active Glossary Injection (§1) — scan ONLY the core lines being translated
    // for known glossary terms and prepend a compact, direct-instruction block.
    // Keeps the model focused on terms present in THIS chunk. Additive: empty
    // when no terms are present, leaving the prompt unchanged.
    if (chunkGlossary.length > 0) {
      const present = scanForGlossaryTerms(coreText.join("\n"), chunkGlossary);
      const glossaryBlock = buildChunkGlossaryBlock(present);
      if (glossaryBlock) contextPromptPrefix = glossaryBlock + contextPromptPrefix;
    }

    // Connection order: per-worker primary (parallel) or listed order (single/fallback).
    // Each connection gets 2 attempts via retryTranslate; on exhaustion we cascade
    // to the next connection. Schema failures are usually systematic, not transient.
    const connOrder = connectionOrderFor(workerIndex);
    // Track which connection actually produced pass-1 so the refinement pass
    // reuses it instead of always hitting connOrder[0] (which may be down in
    // fallback/parallel mode, stalling every chunk on a dead primary).
    let pass1Conn: ResolvedConnection | null = null;
    try {
      const chunkResult = await translateChunkWithFallback(coreText, connOrder, contextPromptPrefix);
      translatedWindow = chunkResult?.result ?? null;
      pass1Conn = chunkResult?.conn ?? null;
    } catch (e: any) {
      if (e?.message === "STOP_REQUESTED") throw e;
      translatedWindow = null;
    }

    // Single-line fallback — translatedWindow is now core-only (coreText.length)
    if (!translatedWindow) {
      translatedWindow = new Array(coreText.length).fill(null);
      for (const idx of coreIndices) {
        const lineText = subtitle[idx]?.data?.text || "";
        const single = await translateSingleWithFallback(lineText, connOrder);
        translatedWindow![idx - coreStart] = single;
      }
    }

    // Refinement Pass (Pass 2) — optional editor pass over the pass-1 output.
    // Additive only: accepted solely when it returns the exact same line count;
    // any failure/mismatch keeps the pass-1 translation untouched.
    if (opts.refinePass && translatedWindow && translatedWindow.every((t) => typeof t === "string")) {
      // Reuse the connection that produced pass-1 (falls back to the primary
      // only when pass-1 came from the single-line fallback path).
      const refineConn = pass1Conn ?? connOrder[0];
      const refined = await refineChunk(coreText, translatedWindow as string[], {
        apiKey: refineConn.apiKey,
        apiHost: refineConn.apiHost,
        model: refineConn.model,
        provider: refineConn.provider,
        lang: opts.lang,
        additional: effectiveAdditional,
        temperature: opts.temperature,
        abortSignal: opts.abortSignal,
        disableToolCalls: opts.disableToolCalls,
        requestTimeoutMs: jobTimeoutMs,
      });
      if (refined) translatedWindow = refined;
    }

    // Write translations back — offset is now relative to coreStart
    let chunkCompleted = 0;
    for (const cue of block) {
      const idx = indexMap.get(cue) as number;
      if (typeof idx !== "number") continue;
      const offset = idx - coreStart;
      const t = translatedWindow?.[offset];
      if (cue?.data && typeof t === "string") {
        cue.data.translatedText = t;
        chunkCompleted++;
      }
    }

    completedCues += chunkCompleted;
    opts.onProgress?.(completedCues, totalCues);

    // Partial save — serialize via promise chain to prevent concurrent file writes.
    // Each processChunk call appends to the chain; writes never interleave.
    saveChain = saveChain.then(() => {
      try {
        saveTranslated(opts.outputPath, parsed, outputExt, subtitle);
      } catch {}
    });
  }

  // Worker: drain the shared chunk queue. workerIndex picks the primary
  // connection in parallel mode.
  async function worker(workerIndex: number) {
    while (chunkQueue.length > 0) {
      const block = chunkQueue.shift();
      if (!block) break;
      await processChunk(block, workerIndex);
    }
  }

  // Launch `concurrency` workers in parallel
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  // Fallback for untranslated
  const untranslated = subtitle.filter((l: SubtitleCue) => !l.data?.translatedText);
  for (const cue of untranslated) {
    if (cue?.data) {
      cue.data.translatedText = await translateSingleWithFallback(cue.data.text || "", connections, 5);
      completedCues++;
      opts.onProgress?.(completedCues, totalCues);
    }
  }

  // Final write
  saveTranslated(opts.outputPath, parsed, outputExt, subtitle);
}

/** Test LLM connection by translating a simple phrase */
export async function testConnection(opts: {
  apiKey: string;
  apiHost: string;
  model: string;
  provider?: CloudProvider;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await translateSingle("Hello, how are you?", {
      ...opts,
      systemPrompt: "Translate to Traditional Chinese (Taiwan).",
      temperature: 0.3,
    });
    return { ok: true, message: `Success: "${result}"` };
  } catch (error: any) {
    return { ok: false, message: error.message || "Connection failed" };
  }
}
