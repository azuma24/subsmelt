import { noSpeechVideos } from "../transcription-history.js";
import type { ScanResult } from "../scanner.js";
import type { TranscribePostAction } from "../transcription-client.js";
import { transcriptionWork, type WorkRunner } from "./work.js";

/** Shared by HTTP and timer scans; enqueues only missing, non-silent media. */
export function enqueueMissingTranscripts(
  result: ScanResult,
  behavior: "ask" | "auto_transcribe" | "auto_transcribe_and_translate",
  runner: WorkRunner = transcriptionWork,
  silent: (path: string) => boolean = (path) => noSpeechVideos.has(path),
): number {
  if (behavior === "ask") return 0;
  const postAction: TranscribePostAction =
    behavior === "auto_transcribe_and_translate" ? "transcribe_and_translate" : "transcribe_only";
  const inputs = result.files
    .filter((file) => file.videoPath && file.subtitles.length === 0 && !silent(file.videoPath))
    .map((file) => ({ kind: "file" as const, input: file.videoPath as string, request: { postAction } }));
  if (inputs.length) {
    runner.store.enqueue(inputs);
    runner.start();
  }
  return inputs.length;
}
