import { useSyncExternalStore } from "react";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import type { TranscribeRequest, TranscribeResponse } from "../../types";
import type { FileProgress } from "./whisper-shared";

/**
 * The Transcribe page's batch lives here, outside the component tree, so
 * navigating away neither aborts it nor loses its progress: on return the page
 * subscribes again and finds the run where it left it.
 */

export interface BatchState {
  running: boolean;
  progress: { done: number; total: number } | null;
  activePath: string | null;
  fileProgress: Record<string, FileProgress>;
}

export type FileOutcome = "done" | "error" | "cancelled";

export const IDLE: BatchState = { running: false, progress: null, activePath: null, fileProgress: {} };

export const startBatch = (state: BatchState, total: number): BatchState =>
  ({ ...state, running: true, progress: { done: 0, total }, activePath: null, fileProgress: {} });

export const beginFile = (state: BatchState, path: string): BatchState => ({ ...state, activePath: path });

export function fileFinished(state: BatchState, path: string, outcome: FileOutcome, done: number): BatchState {
  const current = state.fileProgress[path] ?? {};
  const badge: FileProgress = outcome === "done" ? { ...current, pct: 100, done: true } : { ...current, [outcome]: true };
  return {
    ...state,
    activePath: null,
    progress: state.progress ? { ...state.progress, done } : null,
    fileProgress: { ...state.fileProgress, [path]: badge },
  };
}

/** Badges stay so the list still shows what just happened. */
export const endBatch = (state: BatchState): BatchState => ({ ...state, running: false, progress: null, activePath: null });

/** Merge a transcription:progress event; a phase-only line keeps the last pct. */
export function applyProgressEvent(state: BatchState, data: Record<string, unknown>): BatchState {
  const d = data as { path?: string; pct?: number; done?: boolean; error?: boolean; cancelled?: boolean; phase?: string };
  if (!d.path) return state;
  const current = state.fileProgress[d.path] ?? {};
  return {
    ...state,
    fileProgress: {
      ...state.fileProgress,
      [d.path]: {
        ...current,
        ...(d.pct !== undefined ? { pct: d.pct } : {}),
        ...(d.done !== undefined ? { done: d.done } : {}),
        ...(d.error !== undefined ? { error: d.error } : {}),
        ...(d.cancelled !== undefined ? { cancelled: d.cancelled } : {}),
        ...(d.phase !== undefined ? { phase: d.phase } : {}),
      },
    },
  };
}

let state: BatchState = IDLE;
const listeners = new Set<() => void>();
let cancelRequested = false;

function setState(next: BatchState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getBatchState = (): BatchState => state;

export const useBatchState = (): BatchState => useSyncExternalStore(subscribe, getBatchState);

export const applyTranscriptionProgress = (data: Record<string, unknown>): void =>
  setState(applyProgressEvent(state, data));

export interface BatchRun {
  paths: string[];
  request: (path: string) => TranscribeRequest;
  transcribe: (request: TranscribeRequest) => Promise<TranscribeResponse>;
  onFileError: (path: string, message: string) => void;
  onFinished: (ok: number, total: number) => void;
}

/** Runs the files one after another. A second call while one runs is ignored. */
export async function runBatch(run: BatchRun): Promise<void> {
  if (state.running || run.paths.length === 0) return;
  cancelRequested = false;
  setState(startBatch(state, run.paths.length));
  let ok = 0;
  for (let i = 0; i < run.paths.length; i++) {
    if (cancelRequested) break;
    const path = run.paths[i];
    setState(beginFile(state, path));
    let outcome: FileOutcome = "done";
    try {
      await run.transcribe(run.request(path));
      ok += 1;
    } catch (e: unknown) {
      const message = getErrorMessage(e);
      outcome = /cancelled/i.test(message) ? "cancelled" : "error";
      if (outcome === "error") run.onFileError(path, message);
    }
    setState(fileFinished(state, path, outcome, i + 1));
  }
  setState(endBatch(state));
  run.onFinished(ok, run.paths.length);
}

/** Stops after the current file, which is asked to stop as well (best effort). */
export async function cancelBatch(): Promise<void> {
  cancelRequested = true;
  const target = state.activePath;
  if (!target) return;
  try {
    await api.cancelTranscription({ path: target });
  } catch {
    /* the loop still stops after this file */
  }
}
