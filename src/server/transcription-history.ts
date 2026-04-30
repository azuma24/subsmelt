import fs from "node:fs";
import path from "node:path";
import type { TranscribePostAction, TranscriptionOutputFormat, TranscriptionSubtitleQualityOptions } from "./transcription-client.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
const HISTORY_FILE = path.join(DATA_DIR, "transcription-history.json");
const HISTORY_LIMIT = 100;

export type TranscriptionAttemptStatus = "running" | "succeeded" | "failed";

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
}

interface StartAttemptInput {
  inputPath: string;
  outputPath: string;
  model: string;
  language: string;
  outputFormat: TranscriptionOutputFormat;
  postAction: TranscribePostAction;
  subtitleQuality?: TranscriptionSubtitleQualityOptions | null;
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

  private read(): TranscriptionHistoryEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    return safeJsonParse(fs.readFileSync(this.filePath, "utf8"));
  }

  private write(entries: TranscriptionHistoryEntry[]): void {
    const trimmed = entries
      .slice()
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, HISTORY_LIMIT);
    const json = JSON.stringify(trimmed, null, 2);
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
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  listRecent(limit = 20): TranscriptionHistoryEntry[] {
    return this.read().slice(0, Math.max(1, limit));
  }

  get(id: string): TranscriptionHistoryEntry | undefined {
    return this.read().find((entry) => entry.id === id);
  }
}

export const transcriptionHistory = new TranscriptionHistoryStore(HISTORY_FILE);
