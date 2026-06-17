import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TranscribePostAction, TranscriptionAdvancedOptions, TranscriptionOutputFormat, TranscriptionSubtitleQualityOptions } from "./transcription-client.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
const HISTORY_FILE = path.join(DATA_DIR, "transcription-history.json");
const HISTORY_LIMIT = 100;

export type TranscriptionAttemptStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface TranscriptionHistoryEntry {
  id: string;
  inputPath: string;
  outputPath: string;
  model: string;
  language: string;
  outputFormat: TranscriptionOutputFormat;
  postAction: TranscribePostAction;
  status: TranscriptionAttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  errorSummary: string | null;
  subtitleQuality?: TranscriptionSubtitleQualityOptions | null;
  advancedOptions?: TranscriptionAdvancedOptions | null;
}

interface StartAttemptInput {
  inputPath: string;
  outputPath: string;
  model: string;
  language: string;
  outputFormat: TranscriptionOutputFormat;
  postAction: TranscribePostAction;
  subtitleQuality?: TranscriptionSubtitleQualityOptions | null;
  advancedOptions?: TranscriptionAdvancedOptions | null;
  startedAt?: string;
}

interface FinishAttemptInput {
  status: Exclude<TranscriptionAttemptStatus, "running">;
  finishedAt?: string;
  durationSeconds?: number | null;
  errorSummary?: string | null;
}

function safeJsonParse(raw: string): TranscriptionHistoryEntry[] {
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function summarizeTranscriptionError(error: unknown): string {
  const raw = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error ?? "Transcription failed");

  return raw
    .replace(/[A-Za-z]:\\[^\s"'()]+/g, "[path]")
    .replace(/(?:\/[^/\s"'()]+)+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "Transcription failed";
}

export class TranscriptionHistoryStore {
  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  // In-memory cache is the source of truth once loaded. Serializing disk writes
  // through the chained promise below (instead of reading back from disk on each
  // op) avoids a read-after-write hazard where a deferred flush hasn't landed yet.
  private cache: TranscriptionHistoryEntry[] | null = null;

  // Serializes persistence through a single chained promise so concurrent
  // startAttempt/finishAttempt read-modify-write ops cannot interleave their disk
  // writes and lose updates. Each call's read+mutate runs synchronously in one
  // tick against the in-memory cache (atomic on the event loop), and the
  // resulting JSON snapshot is appended to this chain to flush in FIFO order.
  private writeChain: Promise<void> = Promise.resolve();

  private read(): TranscriptionHistoryEntry[] {
    if (this.cache === null) {
      this.cache = fs.existsSync(this.filePath)
        ? safeJsonParse(fs.readFileSync(this.filePath, "utf8"))
        : [];
    }
    return this.cache;
  }

  private write(entries: TranscriptionHistoryEntry[]): void {
    const trimmed = entries
      .slice()
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, HISTORY_LIMIT);
    // Update the cache synchronously so the next read sees this write, then
    // enqueue the disk flush onto the serialized chain.
    this.cache = trimmed;
    const json = JSON.stringify(trimmed, null, 2);
    this.writeChain = this.writeChain.then(() => this.flush(json));
    // Swallow rejection on the retained chain so one failed flush can't reject
    // every subsequent enqueued write; flush() already falls back internally.
    this.writeChain.catch(() => {});
  }

  private flush(json: string): void {
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, json, "utf8");
    try {
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      fs.writeFileSync(this.filePath, json, "utf8");
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  startAttempt(input: StartAttemptInput): TranscriptionHistoryEntry {
    const entry: TranscriptionHistoryEntry = {
      // crypto.randomUUID() avoids the collision risk of Date.now()+Math.random()
      // when multiple attempts start within the same millisecond under concurrency.
      id: crypto.randomUUID(),
      inputPath: input.inputPath,
      outputPath: input.outputPath,
      model: input.model,
      language: input.language,
      outputFormat: input.outputFormat,
      postAction: input.postAction,
      status: "running",
      startedAt: input.startedAt || new Date().toISOString(),
      finishedAt: null,
      durationSeconds: null,
      errorSummary: null,
      subtitleQuality: input.subtitleQuality ?? null,
      advancedOptions: input.advancedOptions ?? null,
    };
    const entries = this.read();
    entries.unshift(entry);
    this.write(entries);
    return entry;
  }

  finishAttempt(id: string, input: FinishAttemptInput): TranscriptionHistoryEntry | null {
    const entries = this.read();
    const entry = entries.find((item) => item.id === id);
    if (!entry) return null;
    entry.status = input.status;
    entry.finishedAt = input.finishedAt || new Date().toISOString();
    entry.durationSeconds = input.durationSeconds ?? entry.durationSeconds ?? null;
    entry.errorSummary = input.errorSummary ?? null;
    this.write(entries);
    return entry;
  }

  /**
   * Marks any lingering "running" attempts as failed. Called at startup so an
   * attempt that was in-flight when the process restarted does not stay
   * "running" forever. Returns the number of entries reconciled.
   */
  reconcileRunning(reason = "Transcription interrupted by server restart"): number {
    const entries = this.read();
    let reconciled = 0;
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (entry.status === "running") {
        entry.status = "failed";
        entry.finishedAt = entry.finishedAt || now;
        entry.errorSummary = entry.errorSummary || reason;
        reconciled += 1;
      }
    }
    if (reconciled > 0) this.write(entries);
    return reconciled;
  }

  listRecent(limit = 20): TranscriptionHistoryEntry[] {
    return this.read().slice(0, Math.max(1, limit));
  }

  get(id: string): TranscriptionHistoryEntry | undefined {
    return this.read().find((entry) => entry.id === id);
  }
}

export const transcriptionHistory = new TranscriptionHistoryStore(HISTORY_FILE);
