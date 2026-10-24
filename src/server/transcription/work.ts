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
  overridesFromBody,
  runTranscriptionAttempt,
  waitForGpu,
} from "../routes/transcription-runtime.js";
import { beginTranscriptionRun, endTranscriptionRun } from "./in-flight.js";
import { broadcast } from "../sse.js";
import { errorMessage } from "../errors.js";

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

/** Synchronous atomic persistence: a submission is on disk before its ID is returned. */
export class WorkStore {
  private items: WorkItem[];
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.items = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as WorkItem[]) : [];
  }
  list(): WorkItem[] {
    return this.items.map((item) => ({ ...item, request: { ...item.request } }));
  }
  get(id: string): WorkItem | undefined {
    return this.list().find((item) => item.id === id);
  }
  private persist(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items));
    fs.renameSync(tmp, this.file);
  }
  enqueue(inputs: Array<{ kind: "file" | "url"; input: string; request: Record<string, unknown> }>): WorkItem[] {
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
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    broadcast("transcription:work", { id: item.id, input: item.input, status: item.status });
    return this.get(id);
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
    if (!this.active) this.draining = this.drain();
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
  try {
    await waitForGpu(item.input, controller.signal);
    const b = item.request;
    const pick = (key: string, fallback: string) =>
      typeof b[key] === "string" && b[key] ? (b[key] as string) : fallback;
    const outputFormat = pick("outputFormat", settings.transcription_output_format || "srt");
    const result = await transcribeUrlWithBackendStreaming(
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
    const content = (result as { content?: string }).content;
    if (typeof content !== "string" || Buffer.byteLength(content) > 50 * 1024 * 1024)
      throw new Error("Invalid URL transcript content");
    return { content, outputFormat, segments: result.segments };
  } finally {
    signal.removeEventListener("abort", abort);
    endTranscriptionRun(item.input, controller);
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
