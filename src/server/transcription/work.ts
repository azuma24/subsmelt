import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scanFolder, MEDIA_DIR } from "../scanner.js";
import { runQueueSafely } from "../queue.js";
import { getAllSettings } from "../config.js";
import {
  assertMediaPathAllowed,
  transcribeUrlWithBackendStreaming,
  transcribeTimeoutSeconds,
  type TranscribePostAction,
  type TranscriptionOutputFormat,
} from "../transcription-client.js";
import {
  getTranscriptionBackendUrl,
  isAbandonedRun,
  overridesFromBody,
  runTranscriptionAttempt,
  settleTranscriptionRun,
  waitForGpu,
  withTranscriptionSlot,
} from "../routes/transcription-runtime.js";
import { beginTranscriptionRun } from "./in-flight.js";
import { broadcast } from "../sse.js";
import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";

export type WorkStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface WorkItem {
  id: string;
  kind: "file" | "url";
  input: string;
  status: WorkStatus;
  batchId: string;
  request: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  progress: number;
  error?: string;
  outputPath?: string;
  content?: string;
  outputFormat?: string;
  segments?: number;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COMPLETED = 500;
const PROGRESS_WRITE_MS = 5000;

/**
 * The saved work. An unreadable file is set aside rather than deleted, so a
 * bad file costs its queue but never the server's start.
 */
function readItems(file: string): WorkItem[] {
  if (!fs.existsSync(file)) return [];
  try {
    const items: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(items)) return items as WorkItem[];
  } catch {
    // Unparseable: set aside below.
  }
  const aside = `${file}.unreadable-${Date.now()}`;
  fs.renameSync(file, aside);
  logger.error("system", `Transcription work file was unreadable; moved it to ${aside} and started empty`);
  return [];
}

/** Synchronous atomic persistence: a submission is on disk before its ID is returned. */
export class WorkStore {
  private items: WorkItem[];
  private progressWrites = new Map<string, number>();
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.items = readItems(file);
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
  private contentPath(id: string): string {
    return path.join(`${this.file}.outputs`, id);
  }
  private saveContent(id: string, content: string): void {
    const output = this.contentPath(id);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    const tmp = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, output);
  }
  private prune(): void {
    const now = Date.now();
    const completed = this.items.filter((item) => !["queued", "running"].includes(item.status));
    const newest = new Set(completed.slice(-MAX_COMPLETED).map((item) => item.id));
    const removed = this.items.filter(
      (item) =>
        !["queued", "running"].includes(item.status) &&
        (now - Date.parse(item.updatedAt) > RETENTION_MS || !newest.has(item.id)),
    );
    if (!removed.length) return;
    const ids = new Set(removed.map((item) => item.id));
    this.items = this.items.filter((item) => !ids.has(item.id));
    this.persist();
    for (const item of removed) {
      fs.rmSync(this.contentPath(item.id), { force: true });
      this.progressWrites.delete(item.id);
    }
  }
  private persist(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items));
    fs.renameSync(tmp, this.file);
  }
  enqueue(inputs: Array<{ kind: "file" | "url"; input: string; request: Record<string, unknown> }>): WorkItem[] {
    this.prune();
    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();
    const created: WorkItem[] = [];
    const initialLength = this.items.length;
    for (const input of inputs) {
      const existing = this.items.find(
        (item) => item.input === input.input && (item.status === "queued" || item.status === "running"),
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
      };
      this.items.push(item);
      created.push(item);
    }
    if (this.items.length !== initialLength) {
      try {
        this.persist();
      } catch (error) {
        this.items.length = initialLength;
        throw error;
      }
    }
    return created.map((item) => ({ ...item }));
  }
  update(id: string, patch: Partial<WorkItem>): WorkItem | undefined {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return undefined;
    const now = Date.now();
    if (patch.content !== undefined) this.saveContent(id, patch.content);
    const { content: _content, ...metadata } = patch;
    Object.assign(item, metadata, { updatedAt: new Date(now).toISOString() });
    const progressOnly = Object.keys(metadata).length === 1 && metadata.progress !== undefined;
    const shouldPersist = !progressOnly || now - (this.progressWrites.get(id) ?? 0) >= PROGRESS_WRITE_MS;
    if (shouldPersist) {
      this.persist();
      this.progressWrites.set(id, now);
    }
    if (shouldPersist) broadcast("transcription:work", { id: item.id, input: item.input, status: item.status });
    if (!["queued", "running"].includes(item.status)) this.prune();
    return { ...item };
  }
  recover(): number {
    let count = 0;
    for (const item of this.items)
      if (item.status === "running") {
        item.status = "queued";
        item.progress = 0;
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
    ) => Promise<Partial<WorkItem>> = executeWork,
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
        this.store.update(item.id, { status: "running" });
        const controller = new AbortController();
        this.controllers.set(item.id, controller);
        try {
          const result = await this.execute(
            item,
            (pct) => this.store.update(item.id, { progress: pct }),
            controller.signal,
          );
          this.store.update(
            item.id,
            this.cancelled.has(item.id) ? { status: "cancelled" } : { ...result, status: "succeeded", progress: 100 },
          );
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
    if (!item || (item.status !== "queued" && item.status !== "running")) return false;
    this.cancelled.add(id);
    this.store.update(id, { status: "cancelled" });
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
): Promise<Partial<WorkItem>> {
  const settings = getAllSettings();
  if (item.kind === "file") {
    assertMediaPathAllowed(item.input, MEDIA_DIR);
    const request = item.request;
    const { outputPath } = await runTranscriptionAttempt({
      videoPath: item.input,
      postAction:
        request.postAction === "transcribe_and_translate"
          ? "transcribe_and_translate"
          : ("transcribe_only" as TranscribePostAction),
      outputFormat: request.outputFormat as TranscriptionOutputFormat | undefined,
      overrides: {
        ...overridesFromBody(request),
        ...(request.advancedOptions &&
        typeof request.advancedOptions === "object" &&
        !Array.isArray(request.advancedOptions)
          ? { advanced_options: request.advancedOptions }
          : {}),
      },
      settings,
      signal,
      overwrite: request.overwrite === true,
      onProgress,
    });
    if (request.postAction === "transcribe_and_translate" && !signal.aborted) {
      const result = await scanFolder(true);
      if (result.newJobs > 0) setTimeout(() => runQueueSafely(), 100);
    }
    return { outputPath };
  }
  const backendUrl = getTranscriptionBackendUrl(settings);
  if (settings.transcription_enabled !== "1" || !backendUrl) throw new Error("Transcription backend is not configured");
  const controller = beginTranscriptionRun(item.input);
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let abandoned = false;
  // Only a run that reached the backend can still be busy there after the app lets go.
  let reachedBackend = false;
  try {
    const b = item.request;
    const pick = (key: string, fallback: string) =>
      typeof b[key] === "string" && b[key] ? (b[key] as string) : fallback;
    const outputFormat = pick("outputFormat", settings.transcription_output_format || "srt");
    // Counts against transcription_max_concurrent like every file run.
    const result = await withTranscriptionSlot(async () => {
      await waitForGpu(item.input, controller.signal);
      reachedBackend = true;
      return transcribeUrlWithBackendStreaming(
        backendUrl,
        {
          url: item.input,
          output_format: outputFormat,
          model: pick("model", settings.transcription_model || "small"),
          language: pick("language", settings.transcription_language || "auto"),
          device: pick("device", settings.transcription_device || "cpu"),
          compute_type: pick("computeType", settings.transcription_compute_type || "int8"),
          post_action: "transcribe_only",
          ...(b.speakerDiarization === true ? { advanced_options: { speaker_diarization: true } } : {}),
        },
        {
          timeoutSeconds: transcribeTimeoutSeconds(settings),
          token: settings.transcription_backend_token,
          signal: controller.signal,
          onProgress: ({ pct }) => onProgress(pct),
          onPhase: (phase) => broadcast("transcription:progress", { path: item.input, phase }),
        },
      );
    });
    const content = (result as { content?: string }).content;
    if (typeof content !== "string" || Buffer.byteLength(content) > 50 * 1024 * 1024)
      throw new Error("Invalid URL transcript content");
    return { content, outputFormat, segments: result.segments };
  } catch (error) {
    abandoned = reachedBackend && isAbandonedRun(error, controller);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    settleTranscriptionRun(item.input, controller, abandoned);
  }
}

export const transcriptionWork = new WorkRunner(
  new WorkStore(path.join(process.env.DATA_DIR || "./data", "transcription-work.json")),
);
export function validateWorkInput(kind: "file" | "url", input: string): void {
  if (kind === "file") assertMediaPathAllowed(input, MEDIA_DIR);
  else {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http:// and https:// URLs are allowed");
  }
}
