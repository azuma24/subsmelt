/**
 * Transcription orchestrator.
 *
 * Subsmelt never talks to Whisper directly from the browser — this module is
 * the bridge. It:
 *   1. Dispatches pending transcription_jobs rows to the Whisper backend.
 *   2. Polls each in-flight task, mirroring stage/progress/status into SQLite.
 *   3. Broadcasts SSE events so the UI can redraw without polling.
 *   4. On completion, re-scans the media directory so the new subtitle is
 *      picked up, optionally kicking the translation queue.
 */

import path from "node:path";
import {
  createTranscriptionJob,
  deleteTranscriptionJob,
  findActiveTranscriptionForVideo,
  getTranscriptionJob,
  listActiveTranscriptionJobs,
  listTranscriptionJobs,
  updateTranscriptionJob,
  type TranscriptionJobRow,
} from "./db.js";
import { getAllSettings, getSetting } from "./config.js";
import { broadcast } from "./sse.js";
import { logger } from "./logger.js";
import { scanFolder } from "./scanner.js";
import { processQueue } from "./queue.js";
import {
  whisperClient,
  WhisperClientError,
  type WhisperTranscribeRequest,
  type WhisperTaskResponse,
} from "./whisper-client.js";

const POLL_INTERVAL_MS = 2_000;
const activeJobs = new Map<number, { timer: NodeJS.Timeout; remoteId: string }>();

function deriveOutputPath(videoPath: string, format: "srt" | "vtt" | "txt"): string {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  return path.join(dir, `${stem}.${format}`);
}

function normaliseFormat(raw: string): "srt" | "vtt" | "txt" {
  const v = (raw || "srt").toLowerCase();
  return v === "vtt" || v === "txt" ? v : "srt";
}

function normaliseTask(raw: string): "transcribe" | "translate" {
  return raw === "translate" ? "translate" : "transcribe";
}

function buildPayload(job: TranscriptionJobRow): WhisperTranscribeRequest {
  const s = getAllSettings();
  const options = (() => {
    try {
      return job.options_json ? (JSON.parse(job.options_json) as Record<string, unknown>) : {};
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  const model = (options.model as string) || s.whisper_model || "large-v3-turbo";
  const language = (options.language as string) ?? s.whisper_language ?? "";
  const task = normaliseTask((options.task as string) || s.whisper_task || "transcribe");
  const format = normaliseFormat(job.output_format || s.whisper_output_format || "srt");
  const vadEnabled =
    options.vad_enabled !== undefined
      ? Boolean(options.vad_enabled)
      : s.whisper_vad_enabled === "1";
  const uvrEnabled =
    options.uvr_enabled !== undefined
      ? Boolean(options.uvr_enabled)
      : s.whisper_uvr_enabled === "1";
  const uvrModel = (options.uvr_model as string) || s.whisper_uvr_model || "UVR-MDX-NET-Inst_HQ_3.onnx";

  return {
    video_path: job.video_path || "",
    output_path: job.output_path || deriveOutputPath(job.video_path || "", format),
    model,
    language: language || null,
    task,
    output_format: format,
    vad: { enabled: vadEnabled },
    uvr: { enabled: uvrEnabled, model_name: uvrEnabled ? uvrModel : undefined },
  };
}

/** Kick off a transcription for a video. Creates the DB row and dispatches. */
export function enqueueTranscription(videoPath: string): TranscriptionJobRow {
  const existing = findActiveTranscriptionForVideo(videoPath);
  if (existing) return existing;

  const s = getAllSettings();
  const format = normaliseFormat(s.whisper_output_format || "srt");
  const outputPath = deriveOutputPath(videoPath, format);
  const options = {
    model: s.whisper_model,
    language: s.whisper_language,
    task: s.whisper_task,
    vad_enabled: s.whisper_vad_enabled === "1",
    uvr_enabled: s.whisper_uvr_enabled === "1",
    uvr_model: s.whisper_uvr_model,
  };
  const result = createTranscriptionJob({
    kind: "transcribe",
    video_path: videoPath,
    output_path: outputPath,
    output_format: format,
    options_json: JSON.stringify(options),
  });
  const jobId = Number(result.lastInsertRowid);
  const created = getTranscriptionJob(jobId)!;
  logger.info("transcribe", `Enqueued transcription for ${videoPath} → ${outputPath}`);
  broadcast("transcription:start", { id: jobId, videoPath, outputPath });
  void dispatchJob(created).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    updateTranscriptionJob(jobId, { status: "error", error: message, stage: null });
    broadcast("transcription:error", { id: jobId, error: message });
    logger.error("transcribe", `Dispatch failed for job ${jobId}: ${message}`);
  });
  return created;
}

/** Submit a pending job to the Whisper backend and start polling. */
async function dispatchJob(job: TranscriptionJobRow): Promise<void> {
  if (!job.video_path) {
    throw new Error("Transcription job missing video_path");
  }
  if (getSetting("whisper_enabled") !== "1") {
    throw new Error("Transcription is disabled. Enable it in Settings → Transcription.");
  }

  updateTranscriptionJob(job.id, { status: "running", stage: "submitting", error: null });
  const payload = buildPayload(job);
  const { task_id: remoteId } = await whisperClient.submitTranscribe(payload);
  updateTranscriptionJob(job.id, { whisper_task_id: remoteId, stage: "queued" });
  startPolling(job.id, remoteId);
}

/** Download a model via the Whisper backend; mirrors progress locally. */
export function enqueueModelDownload(kind: "whisper" | "uvr", name: string): TranscriptionJobRow {
  const result = createTranscriptionJob({
    kind: "download",
    model_kind: kind,
    model_name: name,
  });
  const jobId = Number(result.lastInsertRowid);
  const row = getTranscriptionJob(jobId)!;
  broadcast("transcription:start", { id: jobId, kind: "download", modelKind: kind, name });
  void dispatchDownload(row).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    updateTranscriptionJob(jobId, { status: "error", error: message, stage: null });
    broadcast("transcription:error", { id: jobId, error: message });
    logger.error("transcribe", `Download dispatch failed for job ${jobId}: ${message}`);
  });
  return row;
}

async function dispatchDownload(job: TranscriptionJobRow): Promise<void> {
  if (!job.model_kind || !job.model_name) {
    throw new Error("Download job missing model_kind/model_name");
  }
  if (getSetting("whisper_enabled") !== "1") {
    throw new Error("Transcription is disabled.");
  }
  updateTranscriptionJob(job.id, { status: "running", stage: "submitting", error: null });
  const { task_id } = await whisperClient.downloadModel(
    job.model_kind as "whisper" | "uvr",
    job.model_name
  );
  updateTranscriptionJob(job.id, { whisper_task_id: task_id, stage: "downloading" });
  startPolling(job.id, task_id);
}

function startPolling(jobId: number, remoteId: string): void {
  stopPolling(jobId);
  const timer = setInterval(() => {
    void pollOnce(jobId).catch((err: unknown) => {
      // Network blip — log once and keep polling. Give up after 30 consecutive
      // failures (~60s with a 2s interval).
      const message = err instanceof Error ? err.message : String(err);
      const entry = activeJobs.get(jobId);
      if (entry) {
        // Stash the consecutive failure count on the timer via a side channel.
        const failures = ((timer as unknown as { _fails?: number })._fails || 0) + 1;
        (timer as unknown as { _fails?: number })._fails = failures;
        if (failures >= 30) {
          stopPolling(jobId);
          updateTranscriptionJob(jobId, {
            status: "error",
            stage: null,
            error: `Lost contact with Whisper backend: ${message}`,
          });
          broadcast("transcription:error", { id: jobId, error: message });
        }
      }
    });
  }, POLL_INTERVAL_MS);
  activeJobs.set(jobId, { timer, remoteId });
}

function stopPolling(jobId: number): void {
  const entry = activeJobs.get(jobId);
  if (entry) {
    clearInterval(entry.timer);
    activeJobs.delete(jobId);
  }
}

async function pollOnce(jobId: number): Promise<void> {
  const job = getTranscriptionJob(jobId);
  if (!job || !job.whisper_task_id) {
    stopPolling(jobId);
    return;
  }
  const remote: WhisperTaskResponse = await whisperClient.getTask(job.whisper_task_id);

  // Reset the failure counter on success.
  const entry = activeJobs.get(jobId);
  if (entry) (entry.timer as unknown as { _fails?: number })._fails = 0;

  const progress = typeof remote.progress === "number" ? remote.progress : 0;
  const stage = remote.stage;

  if (remote.status === "running" || remote.status === "queued") {
    // Persist progress + stage even when the values haven't changed much so the
    // updated_at column reflects liveness.
    updateTranscriptionJob(jobId, {
      status: "running",
      stage,
      progress,
      error: null,
    });
    broadcast("transcription:progress", {
      id: jobId,
      stage,
      progress,
      pct: Math.round(progress * 100),
    });
    return;
  }

  stopPolling(jobId);

  if (remote.status === "done") {
    updateTranscriptionJob(jobId, {
      status: "done",
      stage: null,
      progress: 1,
      error: null,
    });
    logger.info("transcribe", `Job #${jobId} complete (${job.kind})`);
    broadcast("transcription:done", { id: jobId, kind: job.kind, outputPath: job.output_path });
    if (job.kind === "transcribe") {
      void onTranscriptionDone(job);
    }
    return;
  }

  if (remote.status === "cancelled") {
    updateTranscriptionJob(jobId, { status: "cancelled", stage: null, error: null });
    broadcast("transcription:cancelled", { id: jobId });
    return;
  }

  // error
  updateTranscriptionJob(jobId, {
    status: "error",
    stage: null,
    error: remote.error || "Unknown error",
  });
  broadcast("transcription:error", { id: jobId, error: remote.error });
}

function onTranscriptionDone(job: TranscriptionJobRow): void {
  // Ask the scanner to pick up the new subtitle. This creates translation jobs
  // automatically for every enabled translation task.
  try {
    const result = scanFolder(true);
    logger.info(
      "transcribe",
      `Post-transcription rescan: ${result.newJobs} new translation jobs from ${result.totalSubtitles} subtitles`
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn("transcribe", `Post-transcription rescan failed: ${message}`);
    return;
  }
  if (getSetting("auto_translate_after_transcribe") === "1") {
    setTimeout(() => processQueue(), 100);
  }
}

/** Ask the backend to cancel; the next poll will reflect the cancelled state. */
export async function cancelTranscription(jobId: number): Promise<void> {
  const job = getTranscriptionJob(jobId);
  if (!job) throw new Error("Transcription job not found");
  if (!job.whisper_task_id) {
    updateTranscriptionJob(jobId, { status: "cancelled", stage: null, error: null });
    stopPolling(jobId);
    broadcast("transcription:cancelled", { id: jobId });
    return;
  }
  try {
    await whisperClient.cancelTask(job.whisper_task_id);
  } catch (e: unknown) {
    // Even if the backend can't be reached, mark it cancelled locally — the
    // user wanted it stopped. The next poll will reconcile if possible.
    const message = e instanceof Error ? e.message : String(e);
    logger.warn("transcribe", `Cancel call failed for job ${jobId}: ${message}`);
  }
  updateTranscriptionJob(jobId, { status: "cancelled", stage: null });
  stopPolling(jobId);
  broadcast("transcription:cancelled", { id: jobId });
}

/** Re-submit a failed or cancelled job. */
export async function retryTranscription(jobId: number): Promise<TranscriptionJobRow> {
  const job = getTranscriptionJob(jobId);
  if (!job) throw new Error("Transcription job not found");
  updateTranscriptionJob(jobId, {
    status: "pending",
    stage: null,
    progress: 0,
    error: null,
    whisper_task_id: null,
  });
  const refreshed = getTranscriptionJob(jobId)!;
  if (refreshed.kind === "transcribe") {
    await dispatchJob(refreshed);
  } else if (refreshed.kind === "download") {
    await dispatchDownload(refreshed);
  }
  return refreshed;
}

export function listTranscriptions(filter?: { kind?: string; status?: string }): TranscriptionJobRow[] {
  return listTranscriptionJobs(filter);
}

export function deleteTranscription(jobId: number): void {
  stopPolling(jobId);
  deleteTranscriptionJob(jobId);
}

/** Called at server startup: re-attach pollers to any mid-flight remote jobs. */
export function resumeTranscriptionPollers(): void {
  const active = listActiveTranscriptionJobs();
  for (const job of active) {
    if (job.whisper_task_id) {
      logger.info("transcribe", `Resuming poller for job #${job.id} (remote ${job.whisper_task_id})`);
      startPolling(job.id, job.whisper_task_id);
    } else {
      // Job never made it to the backend — leave it as pending, user can retry.
    }
  }
}

export { WhisperClientError };
