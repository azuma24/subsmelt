import type { Express } from "express";
import { createHash } from "node:crypto";
import path from "node:path";
import { getAllSettings } from "../config.js";
import { MEDIA_DIR } from "../scanner.js";
import {
  assertMediaPathAllowed,
  buildTranscriptionRequest,
  fetchTranscriptionHealth,
  fetchTranscriptionLogs,
  preflightTranscription,
  type TranscribePostAction,
  type TranscriptionOutputFormat,
} from "../transcription-client.js";
import { logger } from "../logger.js";
import { getTranscriptionBackendUrl, inFlightTranscriptions, overridesFromBody } from "./transcription-runtime.js";
import { registerTranscriptionModelsRoutes } from "./transcription-models.js";
import { registerTranscriptionHistoryRoutes } from "./transcription-history-routes.js";
import { errorMessage } from "../errors.js";
import {
  transcriptionWork,
  validateWorkInput,
  WorkConflict,
  type WorkInput,
  type WorkItem,
} from "../transcription/work.js";
import { acceptedAdvancedOptions, createWorkPlan, publicWorkPlan } from "../transcription/work-plan.js";
import { readReview, readWorkArtifact } from "../transcription/work-artifacts.js";
import { inspectSubtitle } from "../translator/subtitle-quality.js";
import { transformReviewSubtitle } from "../transcription/review-transforms.js";
import { MAX_REVIEW_BYTES } from "../transcription/work-plan.js";
import { registerAudioTrackRoute } from "../transcription/audio-tracks.js";

// Re-exported so `src/server/index.ts` keeps working after the transcription
// engine moved to ./transcription-runtime.js.
export { getTranscriptionBackendUrl };

const REQUEST_FIELDS = [
  "postAction",
  "outputFormat",
  "model",
  "language",
  "device",
  "computeType",
  "speakerDiarization",
  "advancedOptions",
  "overwrite",
  "profileId",
  "review",
  "exportNote",
  "audioStreamIndex",
  "audioOnlyUpload",
  "forceRecognition",
] as const;
function prepareWorkInput(entry: unknown): WorkInput {
  if (!entry || typeof entry !== "object") throw new Error("Invalid input");
  const row = entry as Record<string, unknown>;
  const { kind, input } = row;
  if ((kind !== "file" && kind !== "url") || typeof input !== "string" || !input.trim() || input.length > 8192) {
    throw new Error("Invalid input");
  }
  validateWorkInput(kind, input);
  const body =
    row.request && typeof row.request === "object" && !Array.isArray(row.request)
      ? (row.request as Record<string, unknown>)
      : {};
  const request = Object.fromEntries(
    REQUEST_FIELDS.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]),
  );
  if (Object.hasOwn(request, "advancedOptions"))
    request.advancedOptions = acceptedAdvancedOptions(request.advancedOptions);
  return { kind, input, request };
}

function publicWork(item: WorkItem) {
  const {
    request: _request,
    plan,
    artifactReady: _ready,
    approvedTargetIds: _targets,
    approvedRevision: _revision,
    reviewStartedAt: _started,
    reviewVideoPath: _video,
    acceptedTargetIds: _accepted,
    ...fields
  } = item;
  return { ...fields, plan: publicWorkPlan(plan) };
}

export function registerTranscriptionRoutes(app: Express): void {
  registerAudioTrackRoute(app);
  app.get("/api/transcribe/work", (_req, res) =>
    res.json({
      items: transcriptionWork.store.list().map(publicWork),
    }),
  );
  app.get("/api/transcribe/work/:id", (req, res) => {
    const item = transcriptionWork.store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Transcription work not found" });
    return res.json(publicWork(item));
  });
  app.post("/api/transcribe/work/plan", (req, res) => {
    try {
      if (Array.isArray(req.body?.inputs)) {
        if (req.body.inputs.length < 1 || req.body.inputs.length > 500) throw new Error("Expected 1–500 inputs");
        return res.json({
          plans: req.body.inputs.map((entry: unknown) => publicWorkPlan(createWorkPlan(prepareWorkInput(entry)))),
        });
      }
      res.json({ plan: publicWorkPlan(createWorkPlan(prepareWorkInput(req.body))) });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/transcribe/work", (req, res) => {
    const inputs = req.body?.inputs;
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 500)
      return res.status(400).json({ error: "Expected 1–500 inputs" });
    try {
      const prepared = inputs.map(prepareWorkInput);
      const key = req.get("Idempotency-Key");
      if (key !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new Error("Invalid idempotency key");
      const digest = key && createHash("sha256").update(JSON.stringify(prepared)).digest("hex");
      const items = transcriptionWork.store.enqueue(prepared, key && digest ? { key, digest } : undefined);
      transcriptionWork.start();
      return res.status(202).json({ items: items.map(publicWork) });
    } catch (error) {
      return res.status(error instanceof WorkConflict ? 409 : 400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/transcribe/work/:id/cancel", (req, res) => {
    return transcriptionWork.cancel(req.params.id)
      ? res.json({ ok: true })
      : res.status(404).json({ error: "Active work not found" });
  });
  app.get("/api/transcribe/work/:id/review", (req, res) => {
    const item = transcriptionWork.store.get(req.params.id);
    if (!item?.outputPath || item.status !== "needs_review")
      return res.status(404).json({ error: "Pending source review not found" });
    try {
      return res.json(readReview(item.outputPath, item.plan?.quality));
    } catch (error) {
      return res.status(409).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/transcribe/work/:id/review/preview", (req, res) => {
    const item = transcriptionWork.store.get(req.params.id);
    if (!item?.outputPath || item.status !== "needs_review")
      return res.status(404).json({ error: "Pending source review not found" });
    try {
      const current = readWorkArtifact(item.outputPath, MAX_REVIEW_BYTES);
      const { revision, content = current.content, operations } = req.body ?? {};
      if (revision !== current.revision)
        return res.status(409).json({ error: "The source transcript changed. Reload it before previewing." });
      if (typeof content !== "string" || Buffer.byteLength(content) > MAX_REVIEW_BYTES)
        throw new Error("Invalid transcript preview");
      const preview = transformReviewSubtitle(content, current.ext, operations);
      const { cues, issues } = inspectSubtitle(preview, current.ext, item.plan?.quality);
      if (!cues.length || issues.some((issue) => issue.code === "invalidTiming"))
        throw new Error("The preview needs valid cues and timestamps");
      return res.json({ content: preview, issues });
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/transcribe/work/:id/review", (req, res) => {
    const { revision, content, targetIds } = req.body ?? {};
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
      return res.status(400).json({ error: "A transcript revision is required" });
    }
    try {
      const item = transcriptionWork.store.approve(req.params.id, revision, content, targetIds);
      transcriptionWork.start();
      return res.status(202).json(publicWork(item));
    } catch (error) {
      return res.status(409).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/transcribe/work/:id/download", (req, res) => {
    const item = transcriptionWork.store.get(req.params.id);
    if (!item || !["succeeded", "needs_review"].includes(item.status)) {
      return res.status(404).json({ error: "Transcript is not ready" });
    }
    try {
      const note = req.query.format === "note";
      const artifact = note ? undefined : item.outputPath ? readWorkArtifact(item.outputPath) : undefined;
      const content = note ? transcriptionWork.store.getNote(item.id) : (artifact?.content ?? item.content);
      if (content === undefined) return res.status(404).json({ error: "Requested output is unavailable" });
      const ext = note ? "md" : (artifact?.ext ?? item.outputFormat ?? "txt");
      const name = `transcript.${ext.replace(/[^a-z0-9]/gi, "") || "txt"}`;
      if (artifact) res.set("X-Transcript-Revision", artifact.revision);
      return res.attachment(name).type("text/plain").send(content);
    } catch (error) {
      return res.status(409).json({ error: errorMessage(error) });
    }
  });
  app.get("/api/transcribe/health", async (_req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    const selectedModel =
      typeof settings.transcription_model === "string" && settings.transcription_model.trim()
        ? settings.transcription_model.trim()
        : "small";
    if (!backendUrl) {
      return res.json({ ok: false, endpointReachable: false, reason: "endpoint-missing" });
    }
    try {
      const health = await fetchTranscriptionHealth(backendUrl, selectedModel, settings.transcription_backend_token);
      return res.json({ ok: true, endpointReachable: true, backendUrl, health });
    } catch (error) {
      return res.json({
        ok: false,
        endpointReachable: false,
        backendUrl,
        reason: "network-error",
        message: errorMessage(error) || "unknown",
      });
    }
  });

  // Proxy the Whisper backend's log tail. The backend logs to a file on its own
  // host — unreachable from the app UI, and on Windows unreachable without
  // sitting at the machine. Mirrors the health route's shape (never throws; a
  // dead backend is reported as data) so the Logs page can render the reason.
  app.get("/api/transcription/logs", async (req, res) => {
    const settings = getAllSettings();
    const backendUrl = getTranscriptionBackendUrl(settings);
    if (!backendUrl) {
      return res.json({ ok: false, reason: "endpoint-missing", lines: [] });
    }
    const requested = parseInt(String(req.query.lines ?? "200"), 10);
    const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 2000) : 200;
    try {
      const body = await fetchTranscriptionLogs(backendUrl, lines, settings.transcription_backend_token);
      return res.json({ ok: true, backendUrl, ...(body as Record<string, unknown>) });
    } catch (error) {
      return res.json({
        ok: false,
        backendUrl,
        reason: "network-error",
        message: errorMessage(error) || "unknown",
        lines: [],
      });
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
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) || "Invalid media path" });
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
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) || "Transcription preflight failed" });
    }
  });

  // `path` is the id the run's progress events carry, a media path or the URL
  // of a URL run. Queued work for that input is cancelled with it, so it does
  // not start once the running attempt stops.
  app.post("/api/transcribe/cancel", (req, res) => {
    const runId = typeof req.body?.path === "string" ? req.body.path : "";
    if (!runId) return res.status(400).json({ error: "path is required" });
    const cancelledWork = transcriptionWork.cancelInput(runId);
    const controller = inFlightTranscriptions.get(runId);
    if (!cancelledWork && !controller)
      return res.status(404).json({ ok: false, error: "No in-flight transcription for that path" });
    controller?.abort();
    logger.info("system", `Cancellation requested for transcription ${path.basename(runId)}`);
    return res.json({ ok: true });
  });

  // Stops every queued and in-flight transcription, including runs outside the
  // work queue such as the YouTube worker's.
  app.post("/api/transcribe/cancel-all", (_req, res) => {
    let cancelled = transcriptionWork.cancelAll();
    for (const [runId, controller] of inFlightTranscriptions) {
      if (controller.signal.aborted) continue;
      controller.abort();
      logger.info("system", `Cancellation requested for transcription ${path.basename(runId)}`);
      cancelled += 1;
    }
    return res.json({ ok: true, cancelled });
  });

  registerTranscriptionModelsRoutes(app);
  registerTranscriptionHistoryRoutes(app);
}
