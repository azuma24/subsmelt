import type { Express } from "express";
import path from "node:path";
import fs from "node:fs";
import { getAllSettings } from "../config.js";
import { scanFolder, MEDIA_DIR } from "../scanner.js";
import { processQueue } from "../queue.js";
import {
  applyPreflightPolicy,
  assertMediaPathAllowed,
  buildTranscriptionRequest,
  fetchTranscriptionHealth,
  localTranscriptionOutputPath,
  preflightTranscription,
  transcribePostActionValues,
  transcribeTimeoutSeconds,
  transcribeWithBackend,
  transcribeWithBackendStreaming,
  transcribeWithBackendUpload,
  transcribeWithBackendUploadStreaming,
  transcribeUrlWithBackendStreaming,
  resolveTransportMode,
  StreamingUnsupportedError,
  type TranscriptionOverrides,
  listBackendModels,
  downloadBackendModel,
  deleteBackendModel,
  type TranscribePostAction,
  type TranscriptionOutputFormat,
} from "../transcription-client.js";
import { summarizeTranscriptionError, transcriptionHistory } from "../transcription-history.js";
import { logger } from "../logger.js";
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
const inFlightTranscriptions = new Map<string, { controller: AbortController; attemptId: string }>();

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
function overridesFromBody(body: unknown): TranscriptionOverrides | undefined {
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

export function registerTranscriptionRoutes(app: Express): void {
  app.get("/api/transcribe/health", async (_req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    const selectedModel = typeof settings.transcription_model === "string" && settings.transcription_model.trim()
      ? settings.transcription_model.trim()
      : "small";
    if (!backendUrl) {
      return res.json({ ok: false, endpointReachable: false, reason: "endpoint-missing" });
    }
    try {
      const health = await fetchTranscriptionHealth(backendUrl, selectedModel, settings.transcription_backend_token);
      return res.json({ ok: true, endpointReachable: true, backendUrl, health });
    } catch (error: any) {
      return res.json({ ok: false, endpointReachable: false, backendUrl, reason: "network-error", message: error?.message || "unknown" });
    }
  });

  app.post("/api/transcribe/preflight", async (req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    const videoPath = typeof req.body?.videoPath === "string" ? req.body.videoPath : "";
    if (!videoPath) return res.status(400).json({ error: "videoPath is required" });
    // Validate the path is inside MEDIA_DIR before any downstream processing.
    try {
      assertMediaPathAllowed(videoPath, MEDIA_DIR);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Invalid media path" });
    }
    try {
      const request = buildTranscriptionRequest({
        videoPath,
        mediaDir: MEDIA_DIR,
        settings,
        outputFormat: req.body?.outputFormat as TranscriptionOutputFormat | undefined,
        postAction: req.body?.postAction as TranscribePostAction | undefined,
        overrides: overridesFromBody(req.body),
      });
      const result = await preflightTranscription(backendUrl, request, settings.transcription_backend_token);
      return res.json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Transcription preflight failed" });
    }
  });

  app.get("/api/transcribe/history", (req, res) => {
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
    res.json({ attempts: transcriptionHistory.listRecent(Number.isFinite(limit) ? limit : 20) });
  });

  app.post("/api/transcribe/history/:id/retry", async (req, res) => {
    const attempt = transcriptionHistory.get(req.params.id);
    if (!attempt) return res.status(404).json({ error: "Transcription attempt not found" });
    // Re-validate the stored input path against the CURRENT MEDIA_DIR before
    // re-running — MEDIA_DIR (or the stored path) may have changed since the
    // original attempt.
    try {
      assertMediaPathAllowed(attempt.inputPath, MEDIA_DIR);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Invalid media path" });
    }
    try {
      const { result, attemptId } = await runTranscriptionAttempt({
        videoPath: attempt.inputPath,
        postAction: attempt.postAction,
        outputFormat: attempt.outputFormat,
      });
      logger.info("system", `Retried transcription ${path.basename(attempt.inputPath)} → ${result.subtitle_path || "subtitle output"}`);

      let scanResult: ReturnType<typeof scanFolder> | null = null;
      if (attempt.postAction === "transcribe_and_translate") {
        scanResult = scanFolder(true);
        if (scanResult.newJobs > 0) setTimeout(() => processQueue(), 100);
      }

      const { ok: _backendOk, ...transcriptionResult } = result as { ok?: boolean } & Record<string, unknown>;
      return res.json({ ok: true, attemptId, ...transcriptionResult, postAction: attempt.postAction, scanResult });
    } catch (error: any) {
      logger.error("system", `Transcription retry failed: ${error?.message || error}`);
      // 502 when the backend itself failed/was unreachable; 400 for client errors.
      return res.status(transcriptionErrorStatus(error)).json({ error: error?.message || "Transcription retry failed" });
    }
  });

  app.post("/api/transcribe", async (req, res) => {
    const settings = getAllSettings();
    const videoPath = typeof req.body?.videoPath === "string" ? req.body.videoPath : "";
    if (!videoPath) return res.status(400).json({ error: "videoPath is required" });
    // Validate the path is inside MEDIA_DIR before it is recorded in history,
    // broadcast over SSE, or used as a map key by any downstream processing.
    try {
      assertMediaPathAllowed(videoPath, MEDIA_DIR);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Invalid media path" });
    }
    const requestedPostAction = req.body?.postAction as TranscribePostAction | undefined;
    const postAction = requestedPostAction && transcribePostActionValues.includes(requestedPostAction) ? requestedPostAction : "transcribe_only";

    try {
      const { result, attemptId } = await runTranscriptionAttempt({
        videoPath,
        postAction,
        outputFormat: req.body?.outputFormat as TranscriptionOutputFormat | undefined,
        overrides: overridesFromBody(req.body),
        settings,
      });
      logger.info("system", `Transcribed ${path.basename(videoPath)} → ${result.subtitle_path || "subtitle output"}`);

      let scanResult: ReturnType<typeof scanFolder> | null = null;
      if (postAction === "transcribe_and_translate") {
        scanResult = scanFolder(true);
        if (scanResult.newJobs > 0) setTimeout(() => processQueue(), 100);
      }

      const { ok: _backendOk, ...transcriptionResult } = result as { ok?: boolean } & Record<string, unknown>;
      return res.json({ ok: true, attemptId, stage: "complete", ...transcriptionResult, postAction, scanResult });
    } catch (error: any) {
      logger.error("system", `Transcription failed: ${error?.message || error}`);
      // 502 when the backend itself failed/was unreachable; 400 for client errors.
      return res.status(transcriptionErrorStatus(error)).json({ error: error?.message || "Transcription failed" });
    }
  });

  // Transcribe remote media (YouTube etc.). The backend fetches via yt-dlp; no
  // local media file is involved, so the rendered subtitle content is returned to
  // the client (which downloads it) rather than written next to a library file.
  app.post("/api/transcribe/url", async (req, res) => {
    const settings = getAllSettings();
    if (settings.transcription_enabled !== "1") return res.status(400).json({ error: "Speech-to-text is disabled in settings" });
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    const b = (req.body || {}) as Record<string, unknown>;
    const url = typeof b.url === "string" ? b.url.trim() : "";
    if (!url) return res.status(400).json({ error: "url is required" });
    // Only http(s) — reject file:/smb:/ftp:/data: before forwarding to yt-dlp.
    let parsedUrl: URL | null = null;
    try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
    if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
      return res.status(400).json({ error: "Only http:// and https:// URLs are allowed" });
    }
    const pick = (k: string, fb: string): string => (typeof b[k] === "string" && b[k] ? (b[k] as string) : fb);

    const outputFormat = pick("outputFormat", settings.transcription_output_format || "srt");
    const body: Record<string, unknown> = {
      url,
      output_format: outputFormat,
      model: pick("model", settings.transcription_model || "small"),
      language: pick("language", settings.transcription_language || "auto"),
      device: pick("device", settings.transcription_device || "cpu"),
      compute_type: pick("computeType", settings.transcription_compute_type || "int8"),
      post_action: "transcribe_only",
      ...(b.speakerDiarization === true ? { advanced_options: { speaker_diarization: true } } : {}),
    };

    // Relay progress/phase to the UI keyed by the URL (acts as the row id).
    const onProgress = ({ pct, processedSeconds, totalSeconds }: { pct: number; processedSeconds: number; totalSeconds: number }) =>
      broadcast("transcription:progress", { path: url, pct, processedSeconds, totalSeconds });
    const onPhase = (phase: string) => broadcast("transcription:progress", { path: url, phase });

    try {
      const result = await transcribeUrlWithBackendStreaming(backendUrl, body, {
        timeoutSeconds: transcribeTimeoutSeconds(settings),
        token: settings.transcription_backend_token,
        onProgress,
        onPhase,
      });
      broadcast("transcription:progress", { path: url, pct: 100, done: true });
      const content = (result as unknown as { content?: string }).content ?? "";
      return res.json({ ok: true, content, language: result.language, segments: result.segments, outputFormat, url });
    } catch (error: any) {
      broadcast("transcription:progress", { path: url, error: true });
      logger.error("system", `URL transcription failed: ${error?.message || error}`);
      // 502 when the backend itself failed/was unreachable; 400 for client errors.
      return res.status(transcriptionErrorStatus(error)).json({ error: error?.message || "URL transcription failed" });
    }
  });

  app.post("/api/transcribe/cancel", (req, res) => {
    const videoPath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!videoPath) return res.status(400).json({ error: "path is required" });
    // Validate the path is inside MEDIA_DIR before using it as a map key.
    try {
      assertMediaPathAllowed(videoPath, MEDIA_DIR);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "Invalid media path" });
    }
    const entry = inFlightTranscriptions.get(videoPath);
    if (!entry) return res.status(404).json({ ok: false, error: "No in-flight transcription for that path" });
    entry.controller.abort();
    logger.info("system", `Cancellation requested for transcription ${path.basename(videoPath)}`);
    return res.json({ ok: true });
  });

  // ======== Whisper Model Manager (proxy to whisper backend) ========
  // The browser never talks to the whisper backend directly (it may live on
  // another host with no CORS). These routes forward to the configured backend,
  // attaching the shared-secret token, and relay download progress to the client
  // over the existing SSE channel (event "model:download") for consistency with
  // transcription progress.

  app.get("/api/whisper/models", async (_req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    try {
      const models = await listBackendModels(backendUrl, settings.transcription_backend_token);
      return res.json({ models });
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "Failed to list whisper models" });
    }
  });

  app.post("/api/whisper/models/download", async (req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (!model) return res.status(400).json({ error: "model is required" });
    // Reject anything outside a safe charset before forwarding to the backend —
    // blocks "../" path traversal and other injection into the model name.
    if (!/^[A-Za-z0-9._-]+$/.test(model)) {
      return res.status(400).json({ error: "Invalid model name" });
    }

    try {
      const result = await downloadBackendModel(backendUrl, model, {
        token: settings.transcription_backend_token,
        onProgress: ({ pct, downloadedMb, totalMb }) => {
          broadcast("model:download", { model, pct, downloadedMb, totalMb });
        },
      });
      broadcast("model:download", { model, pct: 100, done: true, cachePath: result.cachePath });
      logger.info("system", `Downloaded whisper model ${model}${result.cachePath ? ` → ${result.cachePath}` : ""}`);
      return res.json(result);
    } catch (error: any) {
      const message = error?.message || "Whisper model download failed";
      broadcast("model:download", { model, error: true, message });
      logger.error("system", `Whisper model download failed for ${model}: ${message}`);
      return res.status(502).json({ error: message });
    }
  });

  app.delete("/api/whisper/models/:model", async (req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) return res.status(400).json({ error: "Transcription backend URL is not configured" });
    const model = typeof req.params.model === "string" ? req.params.model : "";
    if (!model) return res.status(400).json({ error: "model is required" });
    // Reject anything outside a safe charset before forwarding to the backend —
    // blocks "../" path traversal and other injection into the model name.
    if (!/^[A-Za-z0-9._-]+$/.test(model)) {
      return res.status(400).json({ error: "Invalid model name" });
    }
    try {
      const result = await deleteBackendModel(backendUrl, model, settings.transcription_backend_token);
      logger.info("system", `Deleted whisper model ${model}${typeof result.freedMb === "number" ? ` (freed ${result.freedMb} MB)` : ""}`);
      return res.json(result);
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "Failed to delete whisper model" });
    }
  });
}
