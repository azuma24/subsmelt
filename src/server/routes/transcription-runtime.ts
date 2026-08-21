// Transcription execution engine shared by the transcription routes: backend
// URL resolution, the concurrency gate, the in-flight cancellation registry,
// and the core `runTranscriptionAttempt` that drives a single transcription
// through preflight → backend call → history bookkeeping. Kept separate from
// the route-registration files (transcription.ts, transcription-models.ts,
// transcription-history-routes.ts) so those can depend on it one-way without
// a circular import back into a route file.
import path from "node:path";
import fs from "node:fs";
import { getAllSettings } from "../config.js";
import { MEDIA_DIR } from "../scanner.js";
import {
  applyPreflightPolicy,
  buildTranscriptionRequest,
  localTranscriptionOutputPath,
  transcribeTimeoutSeconds,
  transcribeWithBackend,
  transcribeWithBackendStreaming,
  transcribeWithBackendUpload,
  transcribeWithBackendUploadStreaming,
  resolveTransportMode,
  StreamingUnsupportedError,
  type TranscriptionOverrides,
  type TranscribePostAction,
  type TranscriptionOutputFormat,
} from "../transcription-client.js";
import { summarizeTranscriptionError, transcriptionHistory } from "../transcription-history.js";
import { broadcast } from "../sse.js";

const MAX_SUBTITLE_BYTES = 50 * 1024 * 1024; // 50 MB cap for written subtitle content

// ======== Speech-to-text / transcription ========
export function getTranscriptionBackendUrl(settings = getAllSettings()): string {
  return (settings.transcription_backend_url || process.env.WHISPER_BACKEND_URL || "").replace(/\/+$/, "");
}

// --- Shared transcription concurrency gate ---
// A minimal async semaphore so EVERY transcription entry point (scan auto-
// transcribe, manual POST /api/transcribe, history retry) honors
// transcription_max_concurrent — not just the scan loop. Permits are re-read
// from settings at acquire time so changing the setting takes effect for new
// work without a restart. No deadlocks: a release always follows acquire via
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

// --- In-flight transcription cancellation registry ---
// Maps the local SubSmelt media path of an in-flight transcription to its
// AbortController. POST /api/transcribe/cancel aborts the matching controller,
// which closes the streaming HTTP request → the backend detects the disconnect
// → stops segment iteration. Entries are removed when the attempt settles.
//
// ASSUMPTION: at most one in-flight run per media path. Keying by path means a
// second concurrent run of the SAME path would overwrite this entry and the
// first run would become uncancellable (cancel only reaches the active/latest
// registered run). The UI/queue gate one run per file so this is acceptable;
// the finally-block below only deletes the entry when attemptId still matches,
// so a settling run never clobbers a newer run's registration.
export const inFlightTranscriptions = new Map<string, { controller: AbortController; attemptId: string }>();

// Resolves to true when a streaming run succeeded, so we know whether to skip
// the legacy fallback. Throws StreamingUnsupportedError only for 404s.
async function transcribeRelayingProgress(
  backendUrl: string,
  request: ReturnType<typeof buildTranscriptionRequest>,
  settings: Record<string, string>,
  videoPath: string,
  controller: AbortController,
  transport: ReturnType<typeof resolveTransportMode>,
) {
  const token = settings.transcription_backend_token;
  const onProgress = ({ pct, processedSeconds, totalSeconds }: { pct: number; processedSeconds: number; totalSeconds: number }) => {
    broadcast("transcription:progress", { path: videoPath, pct, processedSeconds, totalSeconds });
  };
  const onPhase = (phase: string) => {
    broadcast("transcription:progress", { path: videoPath, phase });
  };

  if (transport === "upload") {
    // Model B: stream the local media file to the backend; it returns content.
    try {
      return await transcribeWithBackendUploadStreaming(backendUrl, request, videoPath, {
        timeoutSeconds: transcribeTimeoutSeconds(settings),
        token,
        signal: controller.signal,
        onProgress,
        onPhase,
      });
    } catch (error: unknown) {
      if (error instanceof StreamingUnsupportedError) {
        return await transcribeWithBackendUpload(backendUrl, request, videoPath, {
          timeoutSeconds: transcribeTimeoutSeconds(settings),
          token,
        });
      }
      throw error;
    }
  }

  // Model A (shared filesystem): backend reads/writes the mapped path.
  try {
    return await transcribeWithBackendStreaming(backendUrl, request, {
      timeoutSeconds: transcribeTimeoutSeconds(settings),
      token,
      signal: controller.signal,
      onProgress,
      onPhase,
    });
  } catch (error: unknown) {
    if (error instanceof StreamingUnsupportedError) {
      // Older backend without the stream route: fall back to the JSON endpoint.
      // No live progress is available, but transcription still completes.
      return await transcribeWithBackend(backendUrl, request, {
        timeoutSeconds: transcribeTimeoutSeconds(settings),
        token,
      });
    }
    throw error;
  }
}

function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Transcription cancelled/i.test(message);
}

// Picks the HTTP status for a failed transcription. A backend 5xx/507 (e.g. CUDA
// OOM), an unreachable/timed-out backend, or a refused connection is an upstream
// failure → 502 Bad Gateway. Everything else is treated as a client/config error
// → 400. Heuristic on the error message since errors bubble up as plain Error.
export function transcriptionErrorStatus(error: unknown): number {
  // Prefer the carried backend HTTP status when present (set by throwBackendError):
  // a 5xx upstream failure → 502, a 4xx → 400.
  const carried = (error as { backendStatus?: number } | null)?.backendStatus;
  if (typeof carried === "number") return carried >= 500 ? 502 : 400;
  const message = error instanceof Error ? error.message : String(error ?? "");
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
  const pick = (k: string): string | undefined => (typeof b[k] === "string" && b[k] ? (b[k] as string) : undefined);
  const ov: TranscriptionOverrides = {
    ...(pick("model") ? { model: pick("model") } : {}),
    ...(pick("language") ? { language: pick("language") } : {}),
    ...(pick("device") ? { device: pick("device") } : {}),
    ...(pick("computeType") ? { compute_type: pick("computeType") } : {}),
    ...(typeof b.speakerDiarization === "boolean" ? { speaker_diarization: b.speakerDiarization } : {}),
  };
  return Object.keys(ov).length ? ov : undefined;
}

export async function runTranscriptionAttempt(opts: {
  videoPath: string;
  postAction: TranscribePostAction;
  outputFormat?: TranscriptionOutputFormat;
  overrides?: TranscriptionOverrides;
  settings?: Record<string, string>;
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
    overrides: opts.overrides,
  });
  const outputPath = localTranscriptionOutputPath(opts.videoPath, request.language, request.output_format);
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
  });

  const controller = new AbortController();
  inFlightTranscriptions.set(opts.videoPath, { controller, attemptId: attempt.id });

  const transport = resolveTransportMode(settings);

  try {
    const startedAtMs = Date.parse(attempt.startedAt);
    // Upload mode (Model B) skips the HTTP /preflight: that endpoint validates a
    // server-side media path, which does not exist in upload mode. The upload
    // endpoint runs its own resource preflight (422/409). We still honour
    // run_anyway by sending allow_unsafe so the backend won't block a low-RAM run.
    let checkedRequest = request;
    if (transport === "upload") {
      if ((settings.transcription_low_ram_behavior || "").trim() === "run_anyway") {
        checkedRequest = { ...request, allow_unsafe: true };
      }
    } else {
      checkedRequest = await applyPreflightPolicy(backendUrl, request, settings);
    }
    const result = await withTranscriptionSlot(() =>
      transcribeRelayingProgress(backendUrl, checkedRequest, settings, opts.videoPath, controller, transport),
    );
    // Upload mode returns subtitle CONTENT; write it to the local output path
    // (path mode wrote it on the shared filesystem already).
    if (transport === "upload") {
      if (typeof result.content !== "string") {
        throw new Error("Upload transcription returned no subtitle content");
      }
      const contentBytes = Buffer.byteLength(result.content, "utf-8");
      if (contentBytes > MAX_SUBTITLE_BYTES) {
        throw new Error(`Subtitle content too large (${contentBytes} bytes, max ${MAX_SUBTITLE_BYTES})`);
      }
      // Atomic write: write to a temp file in the same dir, then rename. This
      // avoids leaving a half-written subtitle file if the process dies mid-write.
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      // Unique tmp name (pid + timestamp): two runs targeting the same
      // outputPath (e.g. via the retry route, which bypasses the in-flight map)
      // would otherwise collide on a fixed `${outputPath}.tmp`.
      const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmpPath, result.content, "utf-8");
      try {
        await fs.promises.rename(tmpPath, outputPath);
      } catch (renameError) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        throw renameError;
      }
    }
    const finishedAt = new Date().toISOString();
    const durationSeconds = typeof result.duration_seconds === "number"
      ? result.duration_seconds
      : Number.isFinite(startedAtMs)
        ? Math.max(0, (Date.now() - startedAtMs) / 1000)
        : null;
    transcriptionHistory.finishAttempt(attempt.id, {
      status: "succeeded",
      finishedAt,
      durationSeconds,
    });
    broadcast("transcription:progress", { path: opts.videoPath, pct: 100, done: true });
    return { attemptId: attempt.id, result };
  } catch (error: unknown) {
    const cancelled = isCancellationError(error) || controller.signal.aborted;
    const summary = summarizeTranscriptionError(error);
    transcriptionHistory.finishAttempt(attempt.id, {
      status: cancelled ? "cancelled" : "failed",
      finishedAt: new Date().toISOString(),
      errorSummary: cancelled ? "Transcription cancelled" : summary,
    });
    // A cancel is not a failure: broadcast {cancelled:true} WITHOUT error so the
    // client renders "cancelled" rather than an error state. Real failures still
    // carry error:true.
    broadcast("transcription:progress", cancelled
      ? { path: opts.videoPath, cancelled: true }
      : { path: opts.videoPath, error: true });
    const rethrown = new Error(cancelled ? "Transcription cancelled" : summary);
    // Preserve the backend HTTP status so the route can still map a 5xx upstream
    // failure to 502 even though we summarize the message here.
    const carried = (error as { backendStatus?: number } | null)?.backendStatus;
    if (typeof carried === "number") (rethrown as Error & { backendStatus?: number }).backendStatus = carried;
    throw rethrown;
  } finally {
    const current = inFlightTranscriptions.get(opts.videoPath);
    if (current && current.attemptId === attempt.id) inFlightTranscriptions.delete(opts.videoPath);
  }
}
