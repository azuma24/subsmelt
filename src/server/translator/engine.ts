import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type { LlmMode, ResolvedConnection } from "../connections.js";
import type { UsageKind } from "../../shared/usage.js";
import type { CloudProvider, TokenUsage } from "./ai-client.js";
import { translateSingle } from "./ai-client.js";
import { parseSubtitle, readSubtitleFileText, saveTranslated, splitIntoChunks, type SubtitleCue } from "./utils.js";
import { createConnectionHealth } from "./connection-health.js";
import { ContextOverflowError } from "./context-overflow.js";
import { createChunkTranslator } from "./chunk-translator.js";
import { loadCueProgress, removeCueProgress, saveCueProgress } from "./cue-progress.js";
import { createSplitRun } from "./split-run.js";
import { createConcurrencyGate } from "./concurrency-gate.js";
import { awayFromDownMachines, createChunkHedger, type ChunkAttempt, type HedgeTiming } from "./chunk-hedge.js";
import { runLineFallback, singleLineTimeoutMs } from "./fallback-policy.js";
import { buildTranslationSystemPrompt } from "./prompt.js";
import { refineChunk } from "./prompt.js";
import {
  analyzeSubtitlesForContext,
  buildChunkGlossary,
  buildChunkGlossaryBlock,
  buildSeriesGlossarySeed,
  loadSeriesGlossary,
  mergeSeriesGlossary,
  scanForGlossaryTerms,
  type SeriesGlossary,
} from "./context.js";
import { errorMessage } from "../errors.js";
import { assertMediaPathAllowed } from "../transcription/request.js";
import { askConnection, checkCorrections, type CheckResult } from "./correction-check.js";
import {
  correctCueText,
  splitChecked,
  totalCorrections,
  type CompiledCorrection,
  type CorrectionCounts,
} from "../../shared/corrections.js";
export {
  isSafeHttpUrl,
  type JobContextPlan,
  type ModelContextInfo,
  planJobContext,
  probeModelContext,
} from "./context-probe.js";
export {
  type TranslationErrorDiagnostics,
  summarizeTranslationError,
} from "./error-diagnostics.js";

// ── Core translation loop ─────────────────────────────────────────────────────

export interface TranslateFileOptions {
  srtPath: string;
  outputPath: string;
  mediaDir?: string;
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
  /** Per-connection analysis line caps, by connection id; overrides maxAnalysisLines. */
  analysisLinesByConnection?: ReadonlyMap<string, number>;
  /** Per-job request timeout in ms. Overrides the module default (300s). */
  requestTimeoutMs?: number;
  onProgress?: (completed: number, total: number) => void;
  onRetry?: (attempt: number, error: unknown, backoff: number, maxRetries?: number) => void;
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
  /** The connection pool, primary first. Must not be empty. */
  connections: ResolvedConnection[];
  /** single | fallback | parallel. Defaults to "single". */
  llmMode?: LlmMode;
  /**
   * Sends this file's chunks to every connection at once, each held to its own
   * limit, and re-sends a stalled chunk to another machine. Only the queue's
   * llm_split_file mode sets this; it replaces acquireConnection and
   * reservedConnectionIds for the file.
   */
  split?: { limits: ReadonlyMap<string, number>; hedgeTiming?: Partial<HedgeTiming> };
  /**
   * Identifies this work (see work-key.ts). When set, translated cues are saved as
   * chunks finish, and a later run with the same key translates only the rest.
   */
  resumeKey?: string;
  /** Fired when a run keeps cues translated by an earlier run. */
  onResumed?: (keptCues: number, totalCues: number, connections: readonly string[]) => void;
  /** An analysis saved by an earlier run of this same work: used instead of calling the LLM. */
  savedAnalysis?: string;
  /** Fired when the analysis pass starts and ends, however it ends. */
  onAnalysisPhase?: (running: boolean) => void;
  /** Fired once per connection the moment it first produces a translation. */
  onConnectionUsed?: (info: { id: string; label: string }) => void;
  /** Fired whenever a success comes from a different connection than the last one reported here. */
  onConnectionActive?: (info: { id: string; label: string }) => void;
  /** Fired when a connection exhausts its retries and the job cascades to the next. */
  onConnectionError?: (info: { id: string; label: string; error: string }) => void;
  /** Fired when a connection fails its 5×/5s availability probe and is skipped. */
  onConnectionUnavailable?: (info: { id: string; label: string; error: string }) => void;
  /** Fired when repeated timeouts drop a connection for the rest of this job only. */
  onConnectionDropped?: (info: { id: string; label: string; error: string }) => void;
  /**
   * Optional cross-job connection mutex. Queue-level parallel jobs reserve their
   * primary connection for the whole file; fallback users wait here until that
   * primary job releases it.
   */
  acquireConnection?: (conn: ResolvedConnection, signal?: AbortSignal) => Promise<() => void>;
  /** Connections already reserved by this job (so translateFile must not re-lock). */
  reservedConnectionIds?: Iterable<string>;
  /**
   * True while a connection's machine is busy with other work (a transcription
   * on the same GPU). Asked before every chunk; busy connections move to the
   * back of the order, so a fallback takes over and the primary returns when free.
   */
  isConnectionBusy?: (conn: ResolvedConnection) => boolean;
  /** Fired after each successful LLM call, naming what it was for and which connection ran it. */
  onUsage?: (u: UsageEvent) => void;
  /**
   * Subtitle corrections (src/shared/corrections.ts). Source rules fix each
   * cue's text before analysis and translation, so the LLM reads "Sereniti",
   * not Whisper's "Serenity"; output rules fix each translated cue just before
   * the final save. Both default to none.
   */
  sourceCorrections?: readonly CompiledCorrection[];
  outputCorrections?: readonly CompiledCorrection[];
  /** Terms the translator must keep as written; joined into the per-chunk glossary. */
  pinnedTerms?: readonly string[];
  /** Replacements made, per stage, by rule id; fired only when a stage changed something. */
  onCorrections?: (stage: "source" | "output", counts: CorrectionCounts) => void;
  /** What the "check with the translator" rules confirmed and kept, per stage. */
  onCorrectionChecks?: (stage: "source" | "output", result: CheckResult) => void;
}

/** One successful LLM call's tokens, attributed. */
export type UsageEvent = TokenUsage & { kind: UsageKind; connection: ResolvedConnection };

/** Suffix for in-progress translations. */
export const PARTIAL_SUFFIX = ".part";

/** Path incremental saves are written to while a translation is in flight. */
export function partialOutputPath(outputPath: string): string {
  return `${outputPath}${PARTIAL_SUFFIX}`;
}

/** Drop the in-flight `.part` of a job that no longer exists; a no-op when there is none. */
export function removePartialOutput(outputPath: string): void {
  fs.rmSync(partialOutputPath(outputPath), { force: true });
  removeCueProgress(outputPath);
}

/** Prefer the in-flight `.part` file so Preview can show cues before the job finishes. */
export function resolveTranslatedOutputPath(outputPath: string): string {
  const partial = partialOutputPath(outputPath);
  try {
    if (fs.existsSync(partial)) return partial;
  } catch {
    // Fall through to the finished path.
  }
  return outputPath;
}

export async function translateFile(opts: TranslateFileOptions): Promise<void> {
  const sourceExt = path.extname(opts.srtPath).slice(1).toLowerCase();
  const outputExt = path.extname(opts.outputPath).slice(1).toLowerCase() || sourceExt;
  // Incremental progress stays separate until the complete output is published.
  const partialPath = partialOutputPath(opts.outputPath);
  const checkedOutputPath = () =>
    opts.mediaDir
      ? path.join(assertMediaPathAllowed(path.dirname(opts.outputPath), opts.mediaDir), path.basename(opts.outputPath))
      : opts.outputPath;
  // Drop debris from a previous crashed run so this job starts from a clean file.
  try {
    fs.rmSync(partialOutputPath(checkedOutputPath()), { force: true });
  } catch {
    // Non-fatal: the first partial save overwrites whatever is there anyway.
  }
  const content = readSubtitleFileText(opts.srtPath);
  const parsed = parseSubtitle(content, sourceExt);
  // Use per-job timeout if provided, otherwise fall back to module default
  const jobTimeoutMs = opts.requestTimeoutMs;

  // Budgets for the cascade/fallback path live in fallback-policy.ts, where they
  // are covered by tests — they are the fix for a job that could run for hours
  // instead of failing.
  const SINGLE_LINE_TIMEOUT_MS = singleLineTimeoutMs(jobTimeoutMs);

  const connections = opts.connections;
  if (connections.length === 0) throw new Error("No usable LLM connection configured");
  const llmMode: LlmMode = opts.llmMode || "single";
  const usedConnIds = new Set<string>();
  const contributingLabels = new Set<string>();
  let lastActiveId: string | undefined;
  const markUsed = (c: ResolvedConnection) => {
    if (c.id !== lastActiveId) {
      lastActiveId = c.id;
      opts.onConnectionActive?.({ id: c.id, label: c.label });
    }
    if (usedConnIds.has(c.id)) return;
    usedConnIds.add(c.id);
    contributingLabels.add(c.label);
    opts.onConnectionUsed?.({ id: c.id, label: c.label });
  };
  const { onUsage } = opts;
  const usageFor = (kind: UsageKind, connection: ResolvedConnection) =>
    onUsage ? (u: TokenUsage) => onUsage({ ...u, kind, connection }) : undefined;
  const reservedConnectionIds = new Set(opts.reservedConnectionIds ?? []);
  const split = opts.split ? createSplitRun(connections, opts.split.limits) : null;
  // One failed chunk worker fails the whole job, so its siblings must stop
  // calling the LLM and rewriting the partial instead of running the file to
  // completion for a job already marked error. Every LLM call below listens to
  // this signal, which also relays the caller's stop request.
  const jobAbort = new AbortController();
  const abortSignal = opts.abortSignal ? AbortSignal.any([opts.abortSignal, jobAbort.signal]) : jobAbort.signal;
  // Connection probing, the per-job timeout breaker and the acquire/release
  // wrapper live in connection-health.ts — extracted so they can be tested.
  const health = createConnectionHealth({
    onConnectionUnavailable: opts.onConnectionUnavailable,
    onConnectionDropped: opts.onConnectionDropped,
    onRetry: opts.onRetry,
    acquireConnection: split ? split.acquire : opts.acquireConnection,
    reservedConnectionIds: split ? [] : reservedConnectionIds,
    abortSignal,
  });
  const withConnection = health.withConnection;
  const liveConnections = health.live;

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

  // Source corrections run in memory as well as on disk (the queue rewrites the
  // file first), so a source the queue could not rewrite — read-only, not
  // UTF-8 — is still translated from corrected text. A rewritten file makes
  // this a no-op: the rules are stable, so a second pass finds nothing.
  const sourceRules = splitChecked(opts.sourceCorrections ?? []);
  const outputRules = splitChecked(opts.outputCorrections ?? []);
  if (sourceRules.plain.length) {
    const counts: CorrectionCounts = {};
    for (const cue of subtitle) {
      if (cue?.data && typeof cue.data.text === "string") {
        cue.data.text = correctCueText(cue.data.text, sourceRules.plain, counts).text;
      }
    }
    if (totalCorrections(counts) > 0) opts.onCorrections?.("source", counts);
  }

  // "Check with the translator" rules: every match is put to the LLM, and only
  // a confirmed one is replaced. A failure keeps the text as it is.
  const runChecks = async (stage: "source" | "output", checked: CompiledCorrection[], texts: string[]) => {
    // Nothing to ask about: no connection is touched, so an offline one cannot fail the job.
    if (!texts.some((text) => totalCorrections(correctCueText(text, checked).counts) > 0)) return texts;
    for (const conn of connections) {
      if (health.isUnavailable(conn.id)) continue;
      try {
        const result = await withConnection(conn, () =>
          checkCorrections(
            texts,
            checked,
            askConnection(conn, {
              abortSignal,
              requestTimeoutMs: jobTimeoutMs,
              onUsage: usageFor("check", conn),
            }),
          ),
        );
        opts.onCorrectionChecks?.(stage, result);
        return result.texts;
      } catch (error) {
        // An offline or busy connection moves on to the next, as the analysis pass does.
        if (errorMessage(error) === "STOP_REQUESTED" || errorMessage(error) === "JOB_CANCELLED") throw error;
      }
    }
    // No connection could check: every match is kept as written.
    return texts;
  };
  if (sourceRules.checked.length) {
    const fixed = await runChecks(
      "source",
      sourceRules.checked,
      subtitle.map((cue) => String(cue?.data?.text ?? "")),
    );
    subtitle.forEach((cue, i) => {
      if (cue?.data && typeof cue.data.text === "string") cue.data.text = fixed[i];
    });
  }

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
  // It uses the same connection fallback/availability gate as translation so a
  // down primary source doesn't fail the job before chunk fallback can start.
  let analysis = opts.savedAnalysis ?? "";
  let analysisErr: unknown;
  if (!analysis) opts.onAnalysisPhase?.(true);
  try {
    for (const conn of analysis ? [] : idleFirst(connections)) {
      try {
        analysis = await withConnection(conn, () =>
          analyzeSubtitlesForContext(allTexts, {
            apiKey: conn.apiKey,
            apiHost: conn.apiHost,
            model: conn.model,
            provider: conn.provider,
            lang: opts.lang,
            temperature: 0.3,
            abortSignal,
            maxAnalysisLines: opts.analysisLinesByConnection?.get(conn.id) ?? opts.maxAnalysisLines,
            requestTimeoutMs: jobTimeoutMs,
            onUsage: usageFor("analysis", conn),
          }),
        );
        markUsed(conn);
        break;
      } catch (e) {
        if (errorMessage(e) === "STOP_REQUESTED" || errorMessage(e) === "JOB_CANCELLED") throw e;
        analysisErr = e;
        opts.onConnectionError?.({ id: conn.id, label: conn.label, error: String(errorMessage(e) || e) });
      }
    }
  } finally {
    if (!opts.savedAnalysis) opts.onAnalysisPhase?.(false);
  }
  // Every connection failed its availability probe — surface the real error
  // rather than letting the per-line fallback pass source text through and save
  // the job as a successful translation.
  if (!analysis && analysisErr && connections.every((c) => health.isUnavailable(c.id))) {
    throw analysisErr;
  }

  if (analysis) {
    effectiveAdditional = `${effectiveAdditional ? `${effectiveAdditional}\n\n` : ""}[Context]\n${analysis}`;
    opts.onAnalysis?.(analysis);
  }

  // Active Glossary Injection (§1) — parse the analysis blob into structured
  // {term, translation} pairs once, then merge the series glossary on top so
  // every known term is available for per-chunk scanning. Purely additive: if
  // nothing parses, this is an empty list and chunk prompts are unchanged.
  const { chunkGlossary: analysisGlossary, parsedGlossary } = buildChunkGlossary(analysis, seriesGlossary);
  // Correction terms win over whatever the analysis suggested for the same term.
  const pinned = new Set((opts.pinnedTerms ?? []).map((term) => term.toLowerCase()));
  const chunkGlossary = [
    ...(opts.pinnedTerms ?? []).map((term) => ({ term, translation: term })),
    ...analysisGlossary.filter((entry) => !pinned.has(entry.term.toLowerCase())),
  ];

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
  subtitle.forEach((cue, idx) => {
    indexMap.set(cue, idx);
  });

  // ── Multi-connection helpers ────────────────────────────────────────────
  // In parallel mode each worker is assigned a primary connection (round-robin
  // by index); the remaining connections act as per-chunk fallbacks. In single
  // and fallback modes the connections are tried in their listed order.
  function connectionOrderFor(workerIndex: number): ResolvedConnection[] {
    if (split) {
      const primary = split.workerPrimaries[workerIndex];
      return idleFirst([primary, ...connections.filter((conn) => conn !== primary)]);
    }
    if (llmMode !== "parallel" || connections.length <= 1) return idleFirst(connections);
    const primaryIdx = workerIndex % connections.length;
    return idleFirst([connections[primaryIdx], ...connections.filter((_, i) => i !== primaryIdx)]);
  }

  // Busy connections stay in the order as a last resort: with no idle
  // fallback, a slow answer still beats no answer.
  function idleFirst(order: ResolvedConnection[]): ResolvedConnection[] {
    const isBusy = opts.isConnectionBusy;
    if (!isBusy || order.length <= 1) return order;
    const busy = order.filter(isBusy);
    if (busy.length === 0 || busy.length === order.length) return order;
    return [...order.filter((conn) => !busy.includes(conn)), ...busy];
  }

  const { translateChunkWithFallback, translateSingleWithFallback } = createChunkTranslator({
    health,
    jobSignal: abortSignal,
    systemPrompt,
    temperature: opts.temperature,
    disableToolCalls: opts.disableToolCalls,
    chunkSize: opts.chunkSize,
    chunkTimeoutMs: jobTimeoutMs,
    singleLineTimeoutMs: SINGLE_LINE_TIMEOUT_MS,
    markUsed,
    usageFor,
    onRetry: opts.onRetry,
    onConnectionError: opts.onConnectionError,
  });

  const chunks = splitIntoChunks(subtitle, opts.chunkSize);
  let completedCues = 0;
  const contextSize = opts.contextSize;
  const configuredConcurrency = Math.max(1, Math.min(8, opts.parallelChunks || 1));
  // In parallel mode, ensure enough workers to actually exercise every connection.
  // Connection-driven concurrency may exceed the single-endpoint parallel_chunks
  // cap (8): each extra connection is a separate backend, so workers scale up to
  // MAX_PARALLEL_CONNECTIONS distinct primaries.
  const MAX_PARALLEL_CONNECTIONS = 32;
  const concurrency = split
    ? split.workerPrimaries.length
    : llmMode === "parallel"
      ? Math.max(1, Math.min(MAX_PARALLEL_CONNECTIONS, Math.max(configuredConcurrency, connections.length)))
      : configuredConcurrency;

  // Concurrency-limited chunk processor.
  // Each slot processes chunks from the shared queue independently.
  // Progress and partial saves are guarded by a simple mutex flag.
  const saved = opts.resumeKey ? loadCueProgress(checkedOutputPath(), opts.resumeKey) : null;
  const savedCues = saved?.cues ?? new Map<number, string>();
  // Only whole chunks are kept. A chunk with any cue missing runs again in full, so
  // its lines come from one answer and progress counts each cue once.
  const chunkIsSaved = (block: SubtitleCue[]) => block.every((cue) => savedCues.has(indexMap.get(cue) as number));
  const keptChunks = chunks.filter(chunkIsSaved);
  const translatedCues = new Map<number, string>();
  for (const cue of keptChunks.flat()) {
    const index = indexMap.get(cue) as number;
    const text = savedCues.get(index) as string;
    if (cue.data) cue.data.translatedText = text;
    translatedCues.set(index, text);
  }
  if (keptChunks.length > 0) {
    completedCues = translatedCues.size;
    for (const label of saved?.connections ?? []) contributingLabels.add(label);
    opts.onResumed?.(completedCues, totalCues, [...contributingLabels]);
    opts.onProgress?.(Math.min(completedCues, totalCues), totalCues);
    saveTranslated(partialOutputPath(checkedOutputPath()), parsed, outputExt, subtitle);
  }
  const chunkQueue = chunks.filter((block) => !chunkIsSaved(block));
  // Promise-chain mutex: each save is serialized by chaining onto the previous one.
  // Using a flag is NOT safe — two workers can both read `saving === false` before
  // either sets it to true (both pass the check in the same microtask tick).
  let saveChain = Promise.resolve();

  /** Returns "requeue" when the chunk overflowed a context shared with its siblings. */
  async function processChunk(
    block: SubtitleCue[],
    workerIndex: number,
    attempt?: ChunkAttempt,
  ): Promise<"done" | "requeue"> {
    if (attempt?.record.winner) return "done";
    const coreIndices = block
      .map((cue: SubtitleCue) => indexMap.get(cue) as number)
      .filter((n: number) => typeof n === "number")
      .sort((a: number, b: number) => a - b);

    if (coreIndices.length === 0) return "done";

    const coreStart = coreIndices[0];
    const coreEnd = coreIndices[coreIndices.length - 1];
    const contextStart = Math.max(0, coreStart - contextSize);
    const contextEnd = Math.min(subtitle.length - 1, coreEnd + contextSize);

    let translatedWindow: (string | null)[] | null = null;

    // Build separate context prefix and core-only payload.
    // Previously we sent the full window (core + context padding) and asked the
    // model to translate ALL of it, then validated result.length === windowText.length.
    // This caused systematic "did not match schema" failures because thinking models
    // sometimes only translated the core lines (the right thing to do).
    //
    // New approach: send context lines as read-only "preceding/following context"
    // in the prompt, send only core lines as the translation target.
    // Validation is now against coreText.length (always stable).
    const contextBefore = subtitle
      .slice(contextStart, coreStart)
      .map((c: SubtitleCue) => (c?.data ? String(c.data.text).replace(/\n/g, " ").trim() : ""));
    const contextAfter = subtitle
      .slice(coreEnd + 1, contextEnd + 1)
      .map((c: SubtitleCue) => (c?.data ? String(c.data.text).replace(/\n/g, " ").trim() : ""));
    const coreText = subtitle
      .slice(coreStart, coreEnd + 1)
      .map((c: SubtitleCue) => (c?.data ? String(c.data.text).replace(/\n/g, " ").trim() : ""));

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
    const attemptSignal = attempt?.signal ?? abortSignal;
    if (attempt?.targetConn) {
      // A duplicate tries its one connection and ends quietly on any failure:
      // the original attempt is still running and owns the fallback path.
      try {
        const result = await translateChunkWithFallback(coreText, [attempt.targetConn], contextPromptPrefix, {
          signal: attemptSignal,
        });
        if (!result) return "done";
        translatedWindow = result.result;
        pass1Conn = result.conn;
      } catch {
        return "done";
      }
    } else {
      try {
        const chunkResult = await translateChunkWithFallback(
          coreText,
          connOrder,
          contextPromptPrefix,
          attempt && split
            ? {
                signal: attempt.signal,
                // The duplicate already holds that connection's slot for this very chunk.
                skip: (conn) => attempt.record.duplicate?.targetConn === conn,
                onConnection: (conn) => {
                  attempt.record.conn = conn;
                  attempt.record.connLimit = split.limitOf(conn);
                },
              }
            : {},
        );
        translatedWindow = chunkResult?.result ?? null;
        pass1Conn = chunkResult?.conn ?? null;
      } catch (e) {
        if (errorMessage(e) === "STOP_REQUESTED" || errorMessage(e) === "JOB_CANCELLED") throw e;
        // Only an overflow on a shared server escapes the cascade: requeue it.
        if (e instanceof ContextOverflowError) return "requeue";
        translatedWindow = null;
      }
    }

    // Single-line fallback — translatedWindow is now core-only (coreText.length)
    if (!translatedWindow) {
      // A running duplicate may still answer the whole chunk: hear it out first.
      if (attempt && hedger) {
        await hedger.waitForDuplicate(attempt.record);
        if (attempt.record.winner) return "done";
      }
      // Bails out once the backend is clearly not answering, instead of walking
      // every line at one full timeout each (see fallback-policy.ts).
      const { translations } = await runLineFallback(
        coreIndices.map((idx) => subtitle[idx]?.data?.text || ""),
        { translateLine: (lineText) => translateSingleWithFallback(lineText, connOrder, attemptSignal) },
      );
      translatedWindow = new Array(coreText.length).fill(null);
      coreIndices.forEach((idx, i) => {
        translatedWindow![idx - coreStart] = translations[i];
      });
    }

    // Refinement Pass (Pass 2) — optional editor pass over the pass-1 output.
    // Additive only: accepted solely when it returns the exact same line count;
    // any failure/mismatch keeps the pass-1 translation untouched.
    if (opts.refinePass && translatedWindow?.every((t) => typeof t === "string")) {
      // Reuse the connection that produced pass-1 (falls back to the primary
      // only when pass-1 came from the single-line fallback path).
      const refineConn = pass1Conn ?? connOrder[0];
      // A refine failure (null, mismatch, network/abort/schema throw) must never
      // discard a good pass-1 translation. Catch any throw and keep pass-1.
      try {
        const refined = await withConnection(
          refineConn,
          () =>
            refineChunk(coreText, translatedWindow as string[], {
              apiKey: refineConn.apiKey,
              apiHost: refineConn.apiHost,
              model: refineConn.model,
              provider: refineConn.provider,
              lang: opts.lang,
              additional: effectiveAdditional,
              temperature: opts.temperature,
              abortSignal: attemptSignal,
              disableToolCalls: opts.disableToolCalls,
              requestTimeoutMs: jobTimeoutMs,
              onUsage: usageFor("refine", refineConn),
            }),
          attempt?.signal,
        );
        if (refined) translatedWindow = refined;
      } catch (e) {
        if (errorMessage(e) === "STOP_REQUESTED" || errorMessage(e) === "JOB_CANCELLED") throw e;
        // Keep the pass-1 translatedWindow untouched (same as the null case).
      }
    }

    // The first complete answer wins. A partial per-line result must not end a
    // duplicate that could still answer every line.
    if (attempt && hedger) {
      if (!translatedWindow?.every((t) => typeof t === "string")) await hedger.waitForDuplicate(attempt.record);
      if (!hedger.claimWin(attempt)) return "done";
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
        translatedCues.set(idx, t);
        chunkCompleted++;
      }
    }

    completedCues += chunkCompleted;
    // Clamp: a cue counted here (string translatedText, incl. "") can also match
    // the post-pass `untranslated` filter (which treats "" as untranslated),
    // so without clamping progress could briefly exceed 100%.
    opts.onProgress?.(Math.min(completedCues, totalCues), totalCues);

    // Partial save — serialize via promise chain to prevent concurrent file writes.
    // Each processChunk call appends to the chain; writes never interleave.
    saveChain = saveChain.then(() => {
      try {
        const outputPath = checkedOutputPath();
        saveTranslated(partialOutputPath(outputPath), parsed, outputExt, subtitle);
        if (opts.resumeKey) saveCueProgress(outputPath, opts.resumeKey, translatedCues, [...contributingLabels]);
      } catch (e) {
        // Best-effort partial save — never throw (the final write at job end is
        // authoritative), but don't swallow silently: surface it for operators.
        logger.warn("translate", `Partial save failed for ${partialPath}: ${errorMessage(e) || e}`);
      }
    });
    return "done";
  }

  // Worker: drain the shared chunk queue. workerIndex picks the primary
  // connection in parallel mode.
  const gate = createConcurrencyGate(concurrency);
  const hedger = split
    ? createChunkHedger({
        connections,
        usable: (order) =>
          awayFromDownMachines(
            liveConnections(idleFirst(order)),
            connections,
            (id) => health.isUnavailable(id) || health.isDisabled(id),
          ),
        jobSignal: abortSignal,
        runDuplicate: (block, attempt) => processChunk(block, 0, attempt),
        timing: opts.split?.hedgeTiming,
      })
    : null;

  /** An original attempt of a raced chunk: a terminated loser is not a failure, and a duplicate can still save it. */
  async function runOriginal(block: SubtitleCue[], workerIndex: number, attempt: ChunkAttempt) {
    let outcome: "done" | "requeue";
    try {
      outcome = await processChunk(block, workerIndex, attempt);
    } catch (e) {
      if (abortSignal.aborted) throw e;
      if (!attempt.controller.signal.aborted) {
        await hedger?.waitForDuplicate(attempt.record);
        if (!attempt.record.winner || attempt.record.winner === attempt) throw e;
      }
      outcome = "done";
    }
    if (outcome === "done") hedger?.finish(block);
    return outcome;
  }

  function shrinkAfterOverflow(attempt: ChunkAttempt | undefined, limitAtStart: number) {
    const conn = attempt?.record.conn;
    if (split && conn && attempt) {
      if (split.halveFrom(conn, attempt.record.connLimit)) {
        logger.warn(
          "translate",
          `Chunks overflowed ${conn.label}'s shared context window; sending it ${split.limitOf(conn)} at a time`,
        );
      }
      return;
    }
    if (gate.halveFrom(limitAtStart)) {
      logger.warn(
        "translate",
        `Chunks overflowed the model's shared context window; translating ${gate.limit} at a time`,
      );
    }
  }

  async function worker(workerIndex: number) {
    try {
      while (chunkQueue.length > 0) {
        const block = chunkQueue.shift();
        if (!block) break;
        const attempt = hedger?.startOriginal(block);
        await gate.acquire();
        const limitAtStart = gate.limit;
        let outcome: "done" | "requeue";
        try {
          outcome = attempt ? await runOriginal(block, workerIndex, attempt) : await processChunk(block, workerIndex);
          if (outcome === "requeue") shrinkAfterOverflow(attempt, limitAtStart);
        } finally {
          gate.release();
        }
        if (outcome === "requeue") chunkQueue.unshift(block);
      }
      await hedger?.runIdleLoop();
    } catch (e) {
      jobAbort.abort(e);
      throw e;
    }
  }

  // Launch `concurrency` workers in parallel
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  // Fallback for untranslated — covers cues missed by the chunk + single-line
  // passes (including empty-string translations the filter treats as missing).
  const untranslated = subtitle.filter((l: SubtitleCue) => !l.data?.translatedText);
  for (const cue of untranslated) {
    if (cue?.data) {
      try {
        // Same bounded budget as the in-chunk fallback: this sweep runs once per
        // leftover cue, so an unresponsive backend must not cost a full job
        // timeout (times five retries) per line here either.
        cue.data.translatedText = await translateSingleWithFallback(cue.data.text || "", idleFirst(connections));
      } catch (e) {
        if (errorMessage(e) === "STOP_REQUESTED" || errorMessage(e) === "JOB_CANCELLED") throw e;
        // Every cue must end with some text — never drop a line from output.
        // When even the per-line fallback can't translate, pass the source
        // through so the cue still appears (untranslated, but present).
        logger.warn(
          "translate",
          `Per-line fallback failed for a cue; passing source text through: ${errorMessage(e) || e}`,
        );
        cue.data.translatedText = cue.data.text || "";
      }
      completedCues++;
      opts.onProgress?.(Math.min(completedCues, totalCues), totalCues);
    }
  }

  // Safety net: guarantee no cue is left without translatedText (which would
  // drop the line from the rendered output). Any cue that somehow slipped
  // through every pass gets a source passthrough.
  for (const cue of subtitle) {
    if (cue?.data && typeof cue.data.translatedText !== "string") {
      cue.data.translatedText = cue.data.text || "";
    }
  }

  if (outputRules.plain.length) {
    const counts: CorrectionCounts = {};
    for (const cue of subtitle) {
      if (cue?.data && typeof cue.data.translatedText === "string") {
        cue.data.translatedText = correctCueText(cue.data.translatedText, outputRules.plain, counts).text;
      }
    }
    if (totalCorrections(counts) > 0) opts.onCorrections?.("output", counts);
  }
  if (outputRules.checked.length) {
    const fixed = await runChecks(
      "output",
      outputRules.checked,
      subtitle.map((cue) => String(cue?.data?.translatedText ?? "")),
    );
    subtitle.forEach((cue, i) => {
      if (cue?.data && typeof cue.data.translatedText === "string") cue.data.translatedText = fixed[i];
    });
  }

  // Publish the complete subtitle from private staging. The public .part file
  // remains available to Preview until the finished subtitle is in place.
  await saveChain;
  const outputPath = checkedOutputPath();
  saveTranslated(outputPath, parsed, outputExt, subtitle);
  try {
    removePartialOutput(outputPath);
  } catch (error) {
    logger.warn("translate", `Could not remove partial output for ${outputPath}: ${errorMessage(error) || error}`);
  }
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
  } catch (error) {
    return { ok: false, message: errorMessage(error) || "Connection failed" };
  }
}
