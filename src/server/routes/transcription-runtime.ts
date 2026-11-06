// Transcription execution engine shared by the transcription routes: backend
// URL resolution, the concurrency gate, the in-flight cancellation registry,
// and the core `runTranscriptionAttempt` that drives a single transcription
// through preflight → backend call → history bookkeeping. Kept separate from
// the route-registration files (transcription.ts, transcription-models.ts,
// transcription-history-routes.ts) so those can depend on it one-way without
// a circular import back into a route file.
import path from "node:path";
import fs from "node:fs";
import { getAllSettings, preferredChinese } from "../config.js";
import { MEDIA_DIR } from "../scanner.js";
import {
  applyPreflightPolicy,
  assertAudioStreamIndex,
  assertAudioStreamSupport,
  buildTranscriptionRequest,
  fetchTranscriptionHealth,
  localTranscriptionOutputPath,
  transcribeTimeoutSeconds,
  transcribeWithBackend,
  transcribeWithBackendStreaming,
  transcribeFileWithBackendUpload,
  resolveTransportMode,
  StreamingUnsupportedError,
  type TranscribeStreamingOptions,
  type TranscriptionOverrides,
  type TranscribePostAction,
  type BackendTranscriptionResponse,
  type TranscriptionOutputFormat,
} from "../transcription-client.js";
import {
  NO_SPEECH_SUMMARY,
  noSpeechVideos,
  summarizeTranscriptionError,
  transcriptionHistory,
} from "../transcription-history.js";
import { broadcast } from "../sse.js";
import { mkdirShared, shareFile } from "../shared-files.js";
import { standardLangCode } from "../language-codes.js";
import { correctSubtitleFile, correctionsForFile } from "../corrections.js";
import { logger } from "../logger.js";
import { describeCorrections, splitChecked } from "../../shared/corrections.js";
import type { TranscriptionTimings } from "../../shared/transcription.js";
import { startHeldQueue } from "../queue.js";
import { translationHoldsGpu, waitUntilTranscriptionMayStart } from "../gpu-gate.js";
import {
  beginTranscriptionRun,
  endTranscriptionRun,
  holdGpuForAbandonedRun,
  inFlightTranscriptions,
  TranscriptionInFlightError,
} from "../transcription/in-flight.js";
import { errorMessage } from "../errors.js";
import { publishSubtitleSidecar } from "../embedded-subtitles.js";
import { assertSubtitleIntakeStillMissing } from "../subtitle-intake.js";

const MAX_SUBTITLE_BYTES = 50 * 1024 * 1024; // 50 MB cap for written subtitle content

// ======== Speech-to-text / transcription ========
export function getTranscriptionBackendUrl(settings = getAllSettings()): string {
  return (settings.transcription_backend_url || process.env.WHISPER_BACKEND_URL || "").replace(/\/+$/, "");
}

// --- Shared transcription concurrency gate ---
// A minimal async semaphore so every transcription (the work queue's file and
// URL runs, the YouTube worker's) honors transcription_max_concurrent. Permits
// are re-read from settings at acquire time so changing the setting takes
// effect for new work without a restart. No deadlocks: a release always follows acquire via
// try/finally, and waiters are resolved FIFO.
function transcriptionMaxConcurrent(settings = getAllSettings()): number {
  return Math.max(1, Math.min(4, parseInt(settings.transcription_max_concurrent || "1", 10) || 1));
}

let transcriptionActive = 0;
const transcriptionWaiters: Array<() => void> = [];

function acquireTranscriptionSlot(): Promise<void> {
  const limit = transcriptionMaxConcurrent();
  if (transcriptionActive < limit) {
    transcriptionActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    transcriptionWaiters.push(() => {
      transcriptionActive += 1;
      resolve();
    });
  });
}

function releaseTranscriptionSlot(): void {
  transcriptionActive = Math.max(0, transcriptionActive - 1);
  // Capture the limit ONCE: re-reading it inside the loop could let a setting
  // change mid-drain over-admit waiters. Each waiter callback increments
  // `transcriptionActive` itself, so we re-check that bound every iteration.
  const limit = transcriptionMaxConcurrent();
  while (transcriptionActive < limit && transcriptionWaiters.length > 0) {
    const next = transcriptionWaiters.shift();
    if (next) next();
  }
}

async function withTranscriptionSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireTranscriptionSlot();
  try {
    return await fn();
  } finally {
    releaseTranscriptionSlot();
  }
}

// The in-flight registry lives in transcription/in-flight.ts so the GPU gate
// can count runs without importing this module; re-exported for the routes.
export { inFlightTranscriptions, TranscriptionInFlightError };

/**
 * Holds a run until the GPU is free of translation (gpu_shared): the queue's,
 * and a Convert batch's when convert_gpu_shared is on. Tells the page why the
 * run has not started. The YouTube worker checks the same rule before
 * it calls in, so its runs rarely wait here.
 */
export function waitForGpu(runId: string, signal: AbortSignal): Promise<void> {
  return waitUntilTranscriptionMayStart(translationHoldsGpu, signal, () => {
    broadcast("transcription:progress", { path: runId, phase: "waiting_for_gpu" });
  });
}

/**
 * Ends a run's registration. A run the app gave up on may still be busy on the
 * backend, so the GPU gate keeps counting it for a while; either way a
 * translation start the gate held back gets another look.
 */
function settleTranscriptionRun(runId: string, controller: AbortController, abandoned: boolean): void {
  endTranscriptionRun(runId, controller);
  if (abandoned) holdGpuForAbandonedRun(startHeldQueue);
  else startHeldQueue();
}

/** A cancel or a timeout: the app let go of a run the backend may still be working on. */
function isAbandonedRun(error: unknown, controller: AbortController): boolean {
  if (controller.signal.aborted) return true;
  for (let cause: unknown = error; cause; cause = cause instanceof Error ? cause.cause : undefined) {
    const message = cause instanceof Error ? errorMessage(cause) : String(cause);
    if (/timed out/i.test(message)) return true;
  }
  return false;
}

/** One transcription as withTranscriptionRun hands it to its caller. */
export interface TranscriptionRun {
  /** Aborted by the caller's signal, POST /api/transcribe/cancel or cancel-all. */
  readonly controller: AbortController;
  readonly timingsMs: TranscriptionTimings;
  /** Takes a transcription slot, waits until the shared GPU is free, then calls `call` with the slot held. */
  withGpu<T>(call: () => Promise<T>): Promise<T>;
  /** From here the backend may stay busy after the app lets go, so a cancel or timeout keeps the GPU counted. */
  markReachedBackend(): void;
}

/**
 * Runs one transcription the way every entry point must: registered under
 * `runId` (one run per input, cancellable), counted against
 * transcription_max_concurrent, held behind translation on a shared GPU, and
 * settled at the end so a translation start the GPU gate held back gets
 * another look.
 */
export async function withTranscriptionRun<T>(
  runId: string,
  signal: AbortSignal | undefined,
  body: (run: TranscriptionRun) => Promise<T>,
): Promise<T> {
  const controller = beginTranscriptionRun(runId);
  const onCallerAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onCallerAbort, { once: true });
  let reachedBackend = false;
  let abandoned = false;
  const run: TranscriptionRun = {
    controller,
    timingsMs: {},
    withGpu: (call) => {
      const started = performance.now();
      return withTranscriptionSlot(async () => {
        try {
          await waitForGpu(runId, controller.signal);
        } finally {
          run.timingsMs.gpuWait = Math.round(performance.now() - started);
        }
        return call();
      });
    },
    markReachedBackend: () => {
      reachedBackend = true;
    },
  };
  try {
    return await body(run);
  } catch (error) {
    abandoned = reachedBackend && isAbandonedRun(error, controller);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onCallerAbort);
    settleTranscriptionRun(runId, controller, abandoned);
  }
}

async function transcribeRelayingProgress(
  backendUrl: string,
  request: ReturnType<typeof buildTranscriptionRequest>,
  settings: Record<string, string>,
  videoPath: string,
  run: TranscriptionRun,
  transport: ReturnType<typeof resolveTransportMode>,
  observations: {
    onProgress?: (pct: number) => void;
    onMetrics: NonNullable<TranscribeStreamingOptions["onMetrics"]>;
    audioOnlyUpload: boolean;
    onUploadPrepared: (bytes: number, audioOnly: boolean) => void;
  },
) {
  const options: TranscribeStreamingOptions = {
    timeoutSeconds: transcribeTimeoutSeconds(settings),
    token: settings.transcription_backend_token,
    signal: run.controller.signal,
    onProgress({ pct, processedSeconds, totalSeconds }) {
      broadcast("transcription:progress", { path: videoPath, pct, processedSeconds, totalSeconds });
      observations.onProgress?.(pct);
    },
    onPhase(phase) {
      broadcast("transcription:progress", { path: videoPath, phase });
    },
    onMetrics: observations.onMetrics,
  };

  if (transport === "upload") {
    return transcribeFileWithBackendUpload(backendUrl, request, videoPath, {
      ...options,
      audioOnlyUpload: observations.audioOnlyUpload,
      onUploadPrepared(bytes, audioOnly) {
        observations.onUploadPrepared(bytes, audioOnly);
        run.markReachedBackend();
      },
    });
  }

  await assertAudioStreamSupport(backendUrl, request.audio_stream_index, options);
  run.markReachedBackend();
  try {
    return await transcribeWithBackendStreaming(backendUrl, request, options);
  } catch (error: unknown) {
    if (!(error instanceof StreamingUnsupportedError)) throw error;
    return await transcribeWithBackend(backendUrl, request, options);
  }
}

function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? errorMessage(error) : String(error ?? "");
  return /Transcription cancelled/i.test(message);
}

// Picks the HTTP status for a failed transcription. A backend 5xx/507 (e.g. CUDA
// OOM), an unreachable/timed-out backend, or a refused connection is an upstream
// failure → 502 Bad Gateway. Everything else is treated as a client/config error
// → 400. Heuristic on the error message since errors bubble up as plain Error.
export function transcriptionErrorStatus(error: unknown): number {
  if (error instanceof TranscriptionInFlightError) return 409;
  if (error instanceof NoSpeechError) return 422;
  // Prefer the carried backend HTTP status when present (set by throwBackendError):
  // a 5xx upstream failure → 502, a 4xx → 400.
  const carried = (error as { backendStatus?: number } | null)?.backendStatus;
  if (typeof carried === "number") return carried >= 500 ? 502 : 400;
  const message = error instanceof Error ? errorMessage(error) : String(error ?? "");
  // Message heuristic for errors with no carried status (e.g. NDJSON stream error
  // lines): include CUDA/OOM phrasings since those are upstream failures too.
  return /backend|HTTP 5\d\d|unavailable|ECONNREFUSED|timed out|out of memory|cuda/i.test(message) ? 502 : 400;
}

// Extract per-run transcription overrides from a request body. Only string
// values are taken; empty/missing fields are dropped so buildTranscriptionRequest
// falls through to per-folder defaults / global settings.
export function overridesFromBody(body: unknown): TranscriptionOverrides | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (b.audioStreamIndex !== undefined) assertAudioStreamIndex(b.audioStreamIndex);
  const pick = (k: string): string | undefined => (typeof b[k] === "string" && b[k] ? (b[k] as string) : undefined);
  const ov: TranscriptionOverrides = {
    ...(pick("model") ? { model: pick("model") } : {}),
    ...(pick("language") ? { language: pick("language") } : {}),
    ...(pick("device") ? { device: pick("device") } : {}),
    ...(pick("computeType") ? { compute_type: pick("computeType") } : {}),
    ...(typeof b.speakerDiarization === "boolean" ? { speaker_diarization: b.speakerDiarization } : {}),
    ...(typeof b.audioStreamIndex === "number" ? { audio_stream_index: b.audioStreamIndex } : {}),
    ...(typeof b.audioOnlyUpload === "boolean" ? { audio_only_upload: b.audioOnlyUpload } : {}),
    ...(typeof b.forceRecognition === "boolean" ? { force_recognition: b.forceRecognition } : {}),
  };
  return Object.keys(ov).length ? ov : undefined;
}

/** A run that found nothing to transcribe: silence, music, or VAD removed it all. */
export class NoSpeechError extends Error {
  readonly noSpeech = true;
  constructor() {
    super(NO_SPEECH_SUMMARY);
    this.name = "NoSpeechError";
  }
}

// Larger files are transcripts; only a small one can be blank.
const BLANK_CHECK_MAX_BYTES = 4096;

/**
 * True when the run produced no transcript: the backend reports zero segments
 * or the content is blank. In shared mode the backend writes the file itself,
 * possibly empty; a blank file, or one this run wrote for zero segments, is
 * removed so a scan does not take it for a transcript and queue a translation.
 */
async function foundNoSpeech(
  result: BackendTranscriptionResponse,
  expectsContent: boolean,
  outputPath: string,
  startedAtMs: number,
): Promise<boolean> {
  if (expectsContent) {
    return result.segments === 0 || (typeof result.content === "string" && !result.content.trim());
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(outputPath);
  } catch {
    return result.segments === 0;
  }
  const blank =
    stat.size === 0 || (stat.size <= BLANK_CHECK_MAX_BYTES && !(await fs.promises.readFile(outputPath, "utf8")).trim());
  // A coarse filesystem clock can stamp a fresh file a little before the run began.
  const writtenByThisRun = stat.mtimeMs >= startedAtMs - 2_000;
  const noSpeech = result.segments === 0 || blank;
  if (noSpeech && (blank || writtenByThisRun)) await fs.promises.unlink(outputPath).catch(() => {});
  return noSpeech;
}

// The language the backend reports ends up in a file name, so only a plain
// code is taken (en, yue, ko-KR); anything else keeps the name the transcript
// was written with.
const REPORTED_LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/**
 * Where a transcript belongs once its language is known: named with the
 * standard code (Movie.eng.srt), whether the language was set ("en") or
 * detected. Null keeps the name it was written with: no usable language, or a
 * subtitle already there under the standard name that the user did not agree
 * to overwrite.
 */
function languageNamedPath(
  videoPath: string,
  requested: string,
  detected: string | undefined,
  format: TranscriptionOutputFormat,
  overwrite: boolean,
): string | null {
  const language = requested === "auto" ? detected : requested;
  if (!language || !REPORTED_LANGUAGE.test(language)) return null;
  const named = localTranscriptionOutputPath(videoPath, standardLangCode(language, preferredChinese()), format);
  if (path.dirname(named) !== path.dirname(videoPath)) return null;
  if (fs.existsSync(named) && !overwrite) return null;
  return named;
}

export async function runTranscriptionAttempt(opts: {
  videoPath: string;
  postAction: TranscribePostAction;
  outputFormat?: TranscriptionOutputFormat;
  overrides?: TranscriptionOverrides;
  settings?: Record<string, string>;
  onProgress?: (pct: number) => void;
  /** Aborting it cancels the run, as POST /api/transcribe/cancel does. */
  signal?: AbortSignal;
  /**
   * The user confirmed replacing existing subtitles, so the transcript takes
   * the standard name even when a file is already there. Scans and other
   * unattended runs leave it off and never replace a subtitle.
   */
  overwrite?: boolean;
  forceRecognition?: boolean;
  /** An unattended intake may only publish while this revision still lacks a sidecar. */
  subtitleIntakeRevision?: string;
  /** Prefer local publication so an interrupted review run leaves no remote sidecar. */
  deferSharedPublication?: boolean;
}) {
  const settings = opts.settings || getAllSettings();
  const backendUrl = getTranscriptionBackendUrl(settings);
  if (settings.transcription_enabled !== "1") throw new Error("Speech-to-text is disabled in settings");
  if (!backendUrl) throw new Error("Transcription backend URL is not configured");

  const request = buildTranscriptionRequest({
    videoPath: opts.videoPath,
    mediaDir: MEDIA_DIR,
    settings,
    outputFormat: opts.outputFormat,
    postAction: opts.postAction,
    overrides:
      opts.forceRecognition === undefined
        ? opts.overrides
        : { ...opts.overrides, force_recognition: opts.forceRecognition },
  });
  const outputPath = localTranscriptionOutputPath(opts.videoPath, request.language, request.output_format);
  // Refuses a second run of the same file before anything is recorded.
  return withTranscriptionRun(opts.videoPath, opts.signal, async (run) => {
    const transport = resolveTransportMode(settings);
    const intakeRevision = opts.subtitleIntakeRevision;
    const audioOnlyUpload = opts.overrides?.audio_only_upload ?? settings.transcription_audio_only_upload === "1";
    let checkpointHit: boolean | undefined;
    let uploadedBytes: number | undefined;
    let audioOnlyUploaded: boolean | undefined;
    let publishStarted: number | undefined;
    const { timingsMs } = run;
    const attempt = transcriptionHistory.startAttempt({
      // Store the local SubSmelt media path so history retries re-run through
      // MEDIA_DIR validation and optional backend path mapping correctly.
      inputPath: opts.videoPath,
      outputPath,
      model: request.model,
      language: request.language,
      outputFormat: request.output_format,
      postAction: request.post_action,
      subtitleQuality: request.subtitle_quality,
      advancedOptions: request.advanced_options,
      device: request.device,
      computeType: request.compute_type,
      overwrite: opts.overwrite === true,
      audioStreamIndex: request.audio_stream_index,
      audioOnlyUpload: transport === "upload" ? audioOnlyUpload : undefined,
      forceRecognition: request.force_recognition,
    });

    try {
      const startedAtMs = Date.parse(attempt.startedAt);
      // A translation batch on a shared GPU finishes first, and the preflight
      // waits with it: it measures free VRAM, which the batch's model holds.
      const { result, checkedRequest } = await run.withGpu(async () => {
        // Upload mode (Model B) skips the HTTP /preflight: that endpoint validates a
        // server-side media path, which does not exist in upload mode. The upload
        // endpoint runs its own resource preflight (422/409). We still honour
        // run_anyway by sending allow_unsafe so the backend won't block a low-RAM run.
        if (intakeRevision !== undefined) await assertSubtitleIntakeStillMissing(opts.videoPath, intakeRevision);
        let checked = request;
        if (transport === "shared" && (intakeRevision !== undefined || opts.deferSharedPublication)) {
          const health = await fetchTranscriptionHealth(
            backendUrl,
            undefined,
            settings.transcription_backend_token,
            run.controller.signal,
          ).catch((error) => {
            if (intakeRevision !== undefined || run.controller.signal.aborted) throw error;
            return null;
          });
          if (health?.capabilities?.deferredSharedPublication === true) checked = { ...request, defer_publish: true };
          else if (intakeRevision !== undefined) {
            throw new Error(
              "This transcription backend needs an update to publish unattended shared-filesystem subtitles safely.",
            );
          }
        }
        if (transport === "upload") {
          if ((settings.transcription_low_ram_behavior || "").trim() === "run_anyway") {
            checked = { ...request, allow_unsafe: true };
          }
        } else {
          const started = performance.now();
          try {
            checked = await applyPreflightPolicy(backendUrl, checked, settings);
          } finally {
            timingsMs.preflight = Math.round(performance.now() - started);
          }
        }
        const transcribed = await transcribeRelayingProgress(
          backendUrl,
          checked,
          settings,
          opts.videoPath,
          run,
          transport,
          {
            onProgress: opts.onProgress,
            audioOnlyUpload,
            onMetrics(metrics) {
              Object.assign(timingsMs, metrics.timingsMs);
              checkpointHit = metrics.checkpointHit ?? checkpointHit;
            },
            onUploadPrepared(bytes, audioOnly) {
              uploadedBytes = bytes;
              audioOnlyUploaded = audioOnly;
            },
          },
        );
        return { result: transcribed, checkedRequest: checked };
      });
      publishStarted = performance.now();
      const expectsContent = transport === "upload" || checkedRequest.defer_publish === true;
      if (await foundNoSpeech(result, expectsContent, outputPath, startedAtMs)) throw new NoSpeechError();
      // Named with the standard code of its language (Movie.eng.srt), the one Whisper
      // was given or the one it detected, unless a subtitle is already there under
      // it and the user did not confirm an overwrite.
      const namedPath = languageNamedPath(
        opts.videoPath,
        request.language,
        result.language,
        request.output_format,
        opts.overwrite === true,
      );
      let finalPath = outputPath;
      // Upload and unattended shared runs return content for local publication.
      if (expectsContent) {
        finalPath = namedPath ?? outputPath;
        if (typeof result.content !== "string") {
          throw new Error("Transcription backend returned no subtitle content");
        }
        const contentBytes = Buffer.byteLength(result.content, "utf-8");
        if (contentBytes > MAX_SUBTITLE_BYTES) {
          throw new Error(`Subtitle content too large (${contentBytes} bytes, max ${MAX_SUBTITLE_BYTES})`);
        }
        if (intakeRevision !== undefined) {
          await publishSubtitleSidecar(
            opts.videoPath,
            intakeRevision,
            finalPath,
            result.content,
            run.controller.signal,
            async (staged) => {
              applyTranscriptCorrections(staged, settings.correction_rule_sets, finalPath);
              await assertSubtitleIntakeStillMissing(opts.videoPath, intakeRevision);
            },
          );
        } else {
          // Atomic write: write to a temp file in the same dir, then rename. This
          // avoids leaving a half-written subtitle file if the process dies mid-write.
          mkdirShared(path.dirname(finalPath));
          // Unique tmp name (pid + timestamp): one run per file is enforced, but
          // two files can share a transcript name (Movie.mkv, Movie.mp4).
          const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
          try {
            if (opts.deferSharedPublication) run.controller.signal.throwIfAborted();
            await fs.promises.writeFile(tmpPath, result.content, "utf-8");
            if (opts.deferSharedPublication) run.controller.signal.throwIfAborted();
            await fs.promises.rename(tmpPath, finalPath);
            shareFile(finalPath);
          } catch (renameError) {
            await fs.promises.unlink(tmpPath).catch(() => {});
            throw renameError;
          }
        }
      }
      if (!expectsContent && namedPath && namedPath !== outputPath && fs.existsSync(outputPath)) {
        await fs.promises.rename(outputPath, namedPath);
        finalPath = namedPath;
      }
      if (intakeRevision === undefined) applyTranscriptCorrections(finalPath, settings.correction_rule_sets);
      timingsMs.publish = Math.round(performance.now() - publishStarted);
      const finishedAt = new Date().toISOString();
      const durationSeconds =
        typeof result.duration_seconds === "number"
          ? result.duration_seconds
          : Number.isFinite(startedAtMs)
            ? Math.max(0, (Date.now() - startedAtMs) / 1000)
            : null;
      if (request.audio_stream_index === undefined) noSpeechVideos.clear(opts.videoPath);
      transcriptionHistory.finishAttempt(attempt.id, {
        status: "succeeded",
        finishedAt,
        durationSeconds,
        outputPath: finalPath,
        timingsMs,
        checkpointHit,
        uploadedBytes,
        audioOnlyUploaded,
      });
      broadcast("transcription:progress", { path: opts.videoPath, pct: 100, done: true });
      return {
        attemptId: attempt.id,
        result,
        outputPath: finalPath,
        model: checkedRequest.model,
        timingsMs,
        checkpointHit,
        uploadedBytes,
        audioOnlyUploaded,
      };
    } catch (error: unknown) {
      if (publishStarted !== undefined) timingsMs.publish = Math.round(performance.now() - publishStarted);
      const metrics = { timingsMs, checkpointHit, uploadedBytes, audioOnlyUploaded };
      if (error instanceof NoSpeechError) {
        // Not retried by scans: the video stays silent until it changes.
        if (request.audio_stream_index === undefined) noSpeechVideos.mark(opts.videoPath);
        transcriptionHistory.finishAttempt(attempt.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          errorSummary: NO_SPEECH_SUMMARY,
          ...metrics,
        });
        broadcast("transcription:progress", { path: opts.videoPath, error: true, noSpeech: true });
        throw error;
      }
      const cancelled = isCancellationError(error) || run.controller.signal.aborted;
      const summary = summarizeTranscriptionError(error);
      transcriptionHistory.finishAttempt(attempt.id, {
        status: cancelled ? "cancelled" : "failed",
        finishedAt: new Date().toISOString(),
        errorSummary: cancelled ? "Transcription cancelled" : summary,
        ...metrics,
      });
      // A cancel is not a failure: broadcast {cancelled:true} WITHOUT error so the
      // client renders "cancelled" rather than an error state. Real failures still
      // carry error:true.
      broadcast(
        "transcription:progress",
        cancelled ? { path: opts.videoPath, cancelled: true } : { path: opts.videoPath, error: true },
      );
      // The cause keeps the full message, so withTranscriptionRun still sees a timeout the summary cut off.
      const rethrown = new Error(cancelled ? "Transcription cancelled" : summary, { cause: error });
      // Preserve the backend HTTP status so the route can still map a 5xx upstream
      // failure to 502 even though we summarize the message here.
      const carried = (error as { backendStatus?: number } | null)?.backendStatus;
      if (typeof carried === "number") (rethrown as Error & { backendStatus?: number }).backendStatus = carried;
      throw rethrown;
    }
  });
}

/**
 * Source-stage subtitle corrections on a fresh transcript, so the file on disk
 * says "Sereniti" even when it is never translated. Never fails the
 * transcription: a rule problem is logged and the transcript kept as Whisper
 * wrote it (the translation still corrects it in memory).
 */
function applyTranscriptCorrections(transcriptPath: string, raw?: string, rulePath = transcriptPath): void {
  // Rules checked with the translator wait for the translation job, which has an LLM.
  const rules = splitChecked(correctionsForFile(rulePath, "source", [], raw)).plain;
  if (!rules.length) return;
  const name = path.basename(rulePath);
  const result = correctSubtitleFile(transcriptPath, rules);
  if (result.error) {
    logger.warn("system", `Transcript corrections not saved to ${name}: ${result.error}`);
    return;
  }
  if (!result.total) return;
  const details = describeCorrections(result.counts, rules);
  logger.info(
    "system",
    `Corrected ${result.total} term${result.total === 1 ? "" : "s"} in transcript ${name}: ${details
      .map((d) => `${d.find} → ${d.replace} ×${d.count}`)
      .join(", ")}`,
    undefined,
    { stage: "corrections", corrections: details },
  );
}
