import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scanFolder, MEDIA_DIR } from "../scanner.js";
import { runQueueSafely } from "../queue.js";
import { getAllSettings, getTask } from "../config.js";
import { getJobBySrtAndTask } from "../db.js";
import { queueFileTranslation } from "../file-translation.js";
import {
  assertMediaPathAllowed,
  buildUrlTranscriptionRequest,
  transcribeUrlWithBackendStreaming,
  transcribeTimeoutSeconds,
  type TranscribePostAction,
  type TranscriptionOutputFormat,
} from "../transcription-client.js";
import {
  getTranscriptionBackendUrl,
  runTranscriptionAttempt,
  withTranscriptionRun,
} from "../routes/transcription-runtime.js";
import { broadcast } from "../sse.js";
import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";
import { notify } from "../notify.js";
import { createWorkPlan, taskSignature, workOverrides, type WorkPlan } from "./work-plan.js";
import { readWorkArtifact, reviseTranscript, transcriptNote } from "./work-artifacts.js";
import { assertSubtitleIntakeStillMissing } from "../subtitle-intake.js";
import { registerSourceReviewGate } from "./review-gate.js";
import type { TranscriptionTimings } from "../../shared/transcription.js";

export type WorkStatus = "queued" | "running" | "needs_review" | "succeeded" | "failed" | "cancelled";
export interface WorkInput {
  kind: "file" | "url";
  input: string;
  request: Record<string, unknown>;
}
export interface WorkItem extends WorkInput {
  id: string;
  status: WorkStatus;
  batchId: string;
  createdAt: string;
  updatedAt: string;
  progress: number;
  error?: string;
  outputPath?: string;
  content?: string;
  outputFormat?: string;
  segments?: number;
  plan?: WorkPlan;
  artifactReady?: boolean;
  approvedTargetIds?: number[];
  approvedRevision?: string;
  reviewStartedAt?: number;
  reviewVideoPath?: string;
  acceptedTargetIds?: number[];
  translationJobIds?: number[];
  translationIssues?: string[];
  noteReady?: boolean;
  timingsMs?: TranscriptionTimings;
  checkpointHit?: boolean;
  uploadedBytes?: number;
  audioOnlyUploaded?: boolean;
}

interface Submission {
  key: string;
  digest: string;
}
interface SubmissionReceipt extends Submission {
  ids: string[];
}
export class WorkConflict extends Error {}
type WorkResult = Partial<WorkItem> & { note?: string };
interface ReviewSelection {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  taskIds: number[];
}
interface WorkState {
  items: WorkItem[];
  receipts: SubmissionReceipt[];
  reviewSelections?: Record<string, ReviewSelection>;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COMPLETED = 500;
const PROGRESS_WRITE_MS = 5000;

function realFilePath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

const reviewMediaDir = path.resolve(MEDIA_DIR);
const reviewMediaRoot = realFilePath(reviewMediaDir);
function scanPath(file: string): string {
  const absolute = path.resolve(file);
  return absolute.startsWith(`${reviewMediaDir}${path.sep}`)
    ? path.join(reviewMediaRoot, absolute.slice(reviewMediaDir.length + 1))
    : absolute;
}

function artifactStat(file: string) {
  try {
    return fs.statSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/**
 * The saved work. An unreadable file is set aside rather than deleted, so a
 * bad file costs its queue but never the server's start.
 */
function readState(file: string): WorkState {
  if (!fs.existsSync(file)) return { items: [], receipts: [] };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(value)) return { items: value as WorkItem[], receipts: [] };
    if (value?.version === 2 && Array.isArray(value.items) && Array.isArray(value.receipts)) return value;
  } catch {
    // Unparseable: set aside below.
  }
  const aside = `${file}.unreadable-${Date.now()}`;
  fs.renameSync(file, aside);
  logger.error("system", `Transcription work file was unreadable; moved it to ${aside} and started empty`);
  return { items: [], receipts: [] };
}

/** Synchronous atomic persistence: a submission is on disk before its ID is returned. */
export class WorkStore {
  private items: WorkItem[];
  private receipts: SubmissionReceipt[];
  private reviewSelections: Map<string, ReviewSelection>;
  private reviewHolds = new Map<string, WorkItem>();
  private progressWrites = new Map<string, number>();
  constructor(
    private readonly file: string,
    private readonly plan?: (item: WorkInput) => WorkPlan,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const saved = readState(file);
    this.items = saved.items;
    this.receipts = saved.receipts;
    this.reviewSelections = new Map(Object.entries(saved.reviewSelections ?? {}));
    for (const item of this.items) this.updateReviewHold(item);
    // One-time migration of old inline URL results; keep the manifest small.
    let migrated = false;
    for (const item of this.items) {
      if (item.content === undefined) continue;
      this.saveContent(item.id, item.content);
      delete item.content;
      migrated = true;
    }
    if (migrated) this.persist();
    this.prune();
  }
  list(): WorkItem[] {
    this.prune();
    return this.items.map((item) => ({ ...item, request: { ...item.request } }));
  }
  get(id: string): WorkItem | undefined {
    const item = this.list().find((entry) => entry.id === id);
    if (item?.kind !== "url" || item.status !== "succeeded") return item;
    const output = this.contentPath(id);
    return fs.existsSync(output) ? { ...item, content: fs.readFileSync(output, "utf8") } : item;
  }
  private updateReviewHold(item: WorkItem): void {
    const active = ["running", "needs_review", "queued"].includes(item.status);
    const suspect = !item.outputPath && ["cancelled", "failed"].includes(item.status);
    if (item.plan?.review && item.reviewStartedAt && (active || suspect)) this.reviewHolds.set(item.id, item);
    else this.reviewHolds.delete(item.id);
  }
  hasReviewRestrictions(): boolean {
    return this.reviewSelections.size > 0 || this.reviewHolds.size > 0;
  }
  allowsAutomaticTranslation(subtitlePath: string, videoPath: string | undefined, taskId?: number): boolean {
    if (!this.hasReviewRestrictions()) return true;
    const actualVideo = videoPath && scanPath(videoPath);
    const actualSubtitle = scanPath(subtitlePath);
    const selection = this.selectionFor(actualSubtitle);
    for (const item of this.reviewHolds.values()) {
      const matches = item.outputPath
        ? scanPath(item.outputPath) === actualSubtitle
        : actualVideo && item.reviewVideoPath === actualVideo;
      if (!matches) continue;
      if (["running", "needs_review", "queued"].includes(item.status)) return false;
      // A legacy shared backend can publish just before an abort. Hold a
      // new unreviewed subtitle even if the request never returned its path.
      if (!selection && (artifactStat(actualSubtitle)?.mtimeMs ?? 0) >= item.reviewStartedAt!) return false;
    }
    return taskId === undefined || !selection || selection.taskIds.includes(taskId);
  }
  private selectionFor(file: string): ReviewSelection | undefined {
    const selection = this.reviewSelections.get(file);
    if (!selection) return undefined;
    const stat = artifactStat(file);
    return stat &&
      stat.mtimeMs === selection.mtimeMs &&
      stat.ctimeMs === selection.ctimeMs &&
      stat.size === selection.size
      ? selection
      : undefined;
  }
  allowExplicitTarget(subtitlePath: string, taskId: number): void {
    const file = scanPath(subtitlePath);
    const selection = this.selectionFor(file);
    if (!selection || selection.taskIds.includes(taskId)) return;
    this.reviewSelections.set(file, { ...selection, taskIds: [...selection.taskIds, taskId] });
    try {
      this.persist();
    } catch (error) {
      this.reviewSelections.set(file, selection);
      throw error;
    }
  }
  private contentPath(id: string): string {
    return path.join(`${this.file}.outputs`, id);
  }
  getNote(id: string): string | undefined {
    if (!this.items.find((item) => item.id === id)?.noteReady) return undefined;
    const file = `${this.contentPath(id)}.md`;
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  }
  private saveContent(id: string, content: string, note = false): void {
    const output = note ? `${this.contentPath(id)}.md` : this.contentPath(id);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    const tmp = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, output);
  }
  private prune(): void {
    const now = Date.now();
    const retained = (item: WorkItem) => ["queued", "running", "needs_review"].includes(item.status);
    const completed = this.items.filter((item) => !retained(item));
    const newest = new Set(completed.slice(-MAX_COMPLETED).map((item) => item.id));
    const removed = this.items.filter(
      (item) => !retained(item) && (now - Date.parse(item.updatedAt) > RETENTION_MS || !newest.has(item.id)),
    );
    if (!removed.length) return;
    const ids = new Set(removed.map((item) => item.id));
    this.items = this.items.filter((item) => !ids.has(item.id));
    this.receipts = this.receipts.filter((receipt) => receipt.ids.some((id) => !ids.has(id)));
    this.persist();
    for (const item of removed) {
      fs.rmSync(this.contentPath(item.id), { force: true });
      fs.rmSync(`${this.contentPath(item.id)}.md`, { force: true });
      this.progressWrites.delete(item.id);
      this.reviewHolds.delete(item.id);
    }
  }
  private persist(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const state =
      this.receipts.length || this.reviewSelections.size
        ? {
            version: 2,
            items: this.items,
            receipts: this.receipts,
            reviewSelections: Object.fromEntries(this.reviewSelections),
          }
        : this.items;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  enqueue(inputs: WorkInput[], submission?: Submission): WorkItem[] {
    this.prune();
    const prior = submission && this.receipts.find((entry) => entry.key === submission.key);
    if (prior) {
      if (prior.digest !== submission.digest) throw new WorkConflict("Idempotency key was used for different work");
      const found = prior.ids.map((id) => this.items.find((item) => item.id === id));
      if (found.some((item) => !item)) throw new WorkConflict("The previous submission has expired");
      return found.map((item) => ({ ...item! }));
    }
    // Resolve all new inputs before mutating the queue, so a bad plan cannot
    // leave an earlier entry queued in memory without a receipt on disk.
    const prepared = inputs.map((input) => ({ input, plan: this.plan?.(input) }));
    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();
    const created: WorkItem[] = [];
    const initialLength = this.items.length;
    for (const { input, plan } of prepared) {
      const existing = this.items.find(
        (item) => item.input === input.input && ["queued", "running", "needs_review"].includes(item.status),
      );
      if (existing) {
        created.push(existing);
        continue;
      }
      const item: WorkItem = {
        ...input,
        id: crypto.randomUUID(),
        batchId,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        progress: 0,
        ...(plan && { plan }),
        ...(plan?.review && { reviewVideoPath: realFilePath(input.input) }),
      };
      this.items.push(item);
      created.push(item);
    }
    if (submission) this.receipts.push({ ...submission, ids: created.map((item) => item.id) });
    if (this.items.length !== initialLength || submission) {
      try {
        this.persist();
      } catch (error) {
        this.items.length = initialLength;
        if (submission) this.receipts.pop();
        throw error;
      }
    }
    return created.map((item) => ({ ...item }));
  }
  update(id: string, patch: WorkResult): WorkItem | undefined {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return undefined;
    const now = Date.now();
    if (patch.content !== undefined) this.saveContent(id, patch.content);
    if (patch.note !== undefined) this.saveContent(id, patch.note, true);
    const { content: _content, note: _note, ...metadata } = patch;
    if (patch.note !== undefined) metadata.noteReady = true;
    const updated = { ...item, ...metadata, updatedAt: new Date(now).toISOString() };
    const index = this.items.indexOf(item);
    this.items[index] = updated;
    const selectionPath =
      updated.outputPath && updated.plan?.review && ["succeeded", "cancelled", "failed"].includes(updated.status)
        ? scanPath(updated.outputPath)
        : undefined;
    const priorSelection = selectionPath ? this.reviewSelections.get(selectionPath) : undefined;
    const stat = selectionPath ? artifactStat(selectionPath) : undefined;
    if (selectionPath && stat?.isFile()) {
      this.reviewSelections.set(selectionPath, {
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        size: stat.size,
        taskIds: updated.status === "succeeded" ? (updated.acceptedTargetIds ?? []) : [],
      });
    }
    const progressOnly = Object.keys(metadata).length === 1 && metadata.progress !== undefined;
    const shouldPersist = !progressOnly || now - (this.progressWrites.get(id) ?? 0) >= PROGRESS_WRITE_MS;
    if (shouldPersist) {
      try {
        this.persist();
        this.progressWrites.set(id, now);
      } catch (error) {
        this.items[index] = item;
        if (selectionPath) {
          if (priorSelection) this.reviewSelections.set(selectionPath, priorSelection);
          else this.reviewSelections.delete(selectionPath);
        }
        throw error;
      }
    }
    this.updateReviewHold(updated);
    if (shouldPersist)
      broadcast("transcription:work", { id: updated.id, input: updated.input, status: updated.status });
    if (!["queued", "running"].includes(updated.status)) this.prune();
    return { ...updated };
  }
  approve(id: string, revision: string, content: unknown, targetIds: unknown): WorkItem {
    const item = this.items.find((entry) => entry.id === id);
    if (item?.status !== "needs_review" || !item.outputPath)
      throw new WorkConflict("Source review is no longer pending");
    const allowed = item.plan?.targets?.map(({ id }) => id) ?? [];
    if (
      targetIds !== undefined &&
      (!Array.isArray(targetIds) || !targetIds.every((id) => typeof id === "number" && allowed.includes(id)))
    )
      throw new Error("Select translation targets from the saved plan");
    const approvedRevision = reviseTranscript(item.outputPath, revision, content);
    return this.update(id, {
      status: "queued",
      error: undefined,
      approvedRevision,
      approvedTargetIds: [...new Set(targetIds ?? allowed)],
    })!;
  }
  recover(): number {
    let count = 0;
    for (const item of this.items)
      if (item.status === "running") {
        item.status = "queued";
        item.progress = 0;
        this.updateReviewHold(item);
        count++;
      }
    if (count) this.persist();
    return count;
  }
}

export class WorkRunner {
  private active = false;
  private draining: Promise<void> = Promise.resolve();
  private cancelled = new Set<string>();
  constructor(
    readonly store: WorkStore,
    private readonly execute: (
      item: WorkItem,
      onProgress: (pct: number) => void,
      signal: AbortSignal,
    ) => Promise<WorkResult> = executeWork,
  ) {}
  start(): void {
    if (!this.active)
      this.draining = this.drain().catch((error) =>
        logger.error("system", `Transcription work stopped: ${errorMessage(error) || error}`),
      );
  }
  idle(): Promise<void> {
    return this.draining;
  }
  private async drain(): Promise<void> {
    this.active = true;
    try {
      while (true) {
        const item = this.store.list().find((entry) => entry.status === "queued");
        if (!item) break;
        this.store.update(item.id, {
          status: "running",
          ...(item.plan?.review && !item.reviewStartedAt && { reviewStartedAt: Date.now() }),
        });
        const controller = new AbortController();
        this.controllers.set(item.id, controller);
        try {
          const result = await this.execute(
            item,
            (pct) => this.store.update(item.id, { progress: pct }),
            controller.signal,
          );
          const updated = this.store.update(
            item.id,
            this.cancelled.has(item.id)
              ? { ...(item.plan?.review && { outputPath: result.outputPath ?? item.outputPath }), status: "cancelled" }
              : { ...result, status: result.status ?? "succeeded", progress: 100 },
          );
          if (updated?.status === "succeeded" && updated.noteReady) {
            void notify("transcription:note", {
              workId: updated.id,
              title: updated.kind === "file" ? path.parse(updated.input).name : new URL(updated.input).hostname,
            });
          }
        } catch (error) {
          this.store.update(item.id, {
            status: controller.signal.aborted ? "cancelled" : "failed",
            error: errorMessage(error) || String(error),
          });
        } finally {
          this.controllers.delete(item.id);
          this.cancelled.delete(item.id);
        }
      }
    } finally {
      this.active = false;
      if (this.store.list().some((item) => item.status === "queued")) this.start();
    }
  }
  private controllers = new Map<string, AbortController>();
  cancel(id: string): boolean {
    const item = this.store.get(id);
    if (!item || !["queued", "running", "needs_review"].includes(item.status)) return false;
    if (item.status === "running") this.cancelled.add(id);
    if (item.status !== "running" || !item.plan?.review) this.store.update(id, { status: "cancelled" });
    this.controllers.get(id)?.abort();
    return true;
  }
  cancelInput(input: string): number {
    return this.store.list().filter((item) => item.input === input && this.cancel(item.id)).length;
  }
  cancelAll(): number {
    return this.store.list().filter((item) => this.cancel(item.id)).length;
  }
}

async function executeWork(
  item: WorkItem,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<WorkResult> {
  const settings = { ...getAllSettings(), ...item.plan?.settings };
  if (item.kind === "file") {
    assertMediaPathAllowed(item.input, MEDIA_DIR);
    const request = item.request;
    if (item.artifactReady && item.outputPath) return finishFileWork(item, signal);
    if (typeof request.subtitleIntakeRevision === "string") {
      await assertSubtitleIntakeStillMissing(item.input, request.subtitleIntakeRevision);
    }
    const { outputPath, timingsMs, checkpointHit, uploadedBytes, audioOnlyUploaded } = await runTranscriptionAttempt({
      videoPath: item.input,
      postAction:
        request.postAction === "transcribe_and_translate" && !item.plan?.review
          ? "transcribe_and_translate"
          : ("transcribe_only" as TranscribePostAction),
      outputFormat: request.outputFormat as TranscriptionOutputFormat | undefined,
      overrides: workOverrides(request, item.plan?.effective.audio_stream_index),
      settings,
      signal,
      overwrite: request.overwrite === true,
      subtitleIntakeRevision:
        typeof request.subtitleIntakeRevision === "string" ? request.subtitleIntakeRevision : undefined,
      deferSharedPublication: item.plan?.review === true,
      onProgress,
    });
    if (item.plan?.review)
      return {
        outputPath,
        timingsMs,
        checkpointHit,
        uploadedBytes,
        audioOnlyUploaded,
        artifactReady: true,
        status: "needs_review",
      };
    if (item.plan?.targets || item.plan?.exportNote)
      return {
        outputPath,
        timingsMs,
        checkpointHit,
        uploadedBytes,
        audioOnlyUploaded,
        artifactReady: true,
        status: "queued",
      };
    if (request.postAction === "transcribe_and_translate" && !signal.aborted) {
      const result = await scanFolder(true);
      if (result.newJobs > 0) setTimeout(() => runQueueSafely(), 100);
    }
    return { outputPath, timingsMs, checkpointHit, uploadedBytes, audioOnlyUploaded };
  }
  const backendUrl = getTranscriptionBackendUrl(settings);
  if (settings.transcription_enabled !== "1" || !backendUrl) throw new Error("Transcription backend is not configured");
  const request = buildUrlTranscriptionRequest({
    url: item.input,
    settings,
    outputFormat: item.request.outputFormat as TranscriptionOutputFormat | undefined,
    overrides: workOverrides(item.request),
  });
  return withTranscriptionRun(item.input, signal, async (run) => {
    const { timingsMs } = run;
    let checkpointHit: boolean | undefined;
    const result = await run.withGpu(() => {
      run.markReachedBackend();
      return transcribeUrlWithBackendStreaming(
        backendUrl,
        { ...request },
        {
          timeoutSeconds: transcribeTimeoutSeconds(settings),
          token: settings.transcription_backend_token,
          signal: run.controller.signal,
          onProgress: ({ pct }) => onProgress(pct),
          onMetrics: (metrics) => {
            Object.assign(timingsMs, metrics.timingsMs);
            checkpointHit = metrics.checkpointHit ?? checkpointHit;
          },
          onPhase: (phase) => broadcast("transcription:progress", { path: item.input, phase }),
        },
      );
    });
    const content = (result as { content?: string }).content;
    if (typeof content !== "string" || Buffer.byteLength(content) > 50 * 1024 * 1024)
      throw new Error("Invalid URL transcript content");
    const note = item.plan?.exportNote
      ? transcriptNote(new URL(item.input).hostname, content, request.output_format)
      : undefined;
    return { content, outputFormat: request.output_format, segments: result.segments, timingsMs, checkpointHit, note };
  });
}

function finishFileWork(item: WorkItem, signal: AbortSignal): WorkResult {
  const outputPath = item.outputPath!;
  const { file, content, ext, revision } = readWorkArtifact(outputPath);
  if (item.plan?.review && item.approvedRevision !== revision) {
    return { status: "needs_review", error: "The transcript changed after approval" };
  }
  const note = item.plan?.exportNote ? transcriptNote(path.parse(item.input).name, content, ext) : undefined;
  const translationJobIds: number[] = [];
  const acceptedTargetIds: number[] = [];
  const translationIssues: string[] = [];
  let startQueue = false;
  for (const target of item.plan?.targets ?? []) {
    if (signal.aborted) break;
    if (item.approvedTargetIds && !item.approvedTargetIds.includes(target.id)) continue;
    const task = getTask(target.id);
    if (!task || taskSignature(task) !== target.signature) {
      translationIssues.push(`${target.label}: translation settings changed after submission`);
      continue;
    }
    const previous = getJobBySrtAndTask(file, target.id);
    if (previous?.status === "translating") {
      translationIssues.push(`${target.label}: a translation is already running for this source`);
      continue;
    }
    const outcome = queueFileTranslation(file, { taskId: target.id });
    if (outcome.kind === "rejected") translationIssues.push(`${target.label}: ${outcome.error}`);
    else {
      translationJobIds.push(outcome.jobId);
      acceptedTargetIds.push(target.id);
      if (outcome.kind === "queued" || previous?.status === "pending") startQueue = true;
    }
  }
  if (startQueue) setTimeout(() => runQueueSafely(translationJobIds), 100);
  return { outputPath, outputFormat: ext, translationJobIds, acceptedTargetIds, translationIssues, note };
}

export const transcriptionWork = new WorkRunner(
  new WorkStore(path.join(process.env.DATA_DIR || "./data", "transcription-work.json"), createWorkPlan),
);
registerSourceReviewGate(
  (subtitlePath, videoPath, taskId) =>
    transcriptionWork.store.allowsAutomaticTranslation(subtitlePath, videoPath, taskId),
  () => transcriptionWork.store.hasReviewRestrictions(),
  (subtitlePath, taskId) => transcriptionWork.store.allowExplicitTarget(subtitlePath, taskId),
);
export function validateWorkInput(kind: "file" | "url", input: string): void {
  if (kind === "file") assertMediaPathAllowed(input, MEDIA_DIR);
  else {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http:// and https:// URLs are allowed");
  }
}
