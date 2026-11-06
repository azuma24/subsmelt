import { assertSubtitleIntakeStillMissing } from "../subtitle-intake.js";
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
    .filter((file) => file.videoPath && !file.intake && file.subtitles.length === 0 && !silent(file.videoPath))
    .map((file) => ({ kind: "file" as const, input: file.videoPath as string, request: { postAction } }));
  if (inputs.length) {
    runner.store.enqueue(inputs);
    runner.start();
  }
  return inputs.length;
}

/** Execute only the explicit ASR decisions made by the shared intake pass. */
export async function enqueueIntakeTranscripts(result: ScanResult, runner: WorkRunner = transcriptionWork) {
  const inputs = [];
  for (const { videoPath, intake } of result.files) {
    if (
      !videoPath ||
      !intake?.revision ||
      (intake.action !== "transcribe" && intake.action !== "transcribe_and_translate") ||
      noSpeechVideos.has(videoPath)
    )
      continue;
    try {
      await assertSubtitleIntakeStillMissing(videoPath, intake.revision);
    } catch {
      continue; // A concurrent write changed the video or added a subtitle. A later scan reevaluates it.
    }
    inputs.push({
      kind: "file" as const,
      input: videoPath,
      request: {
        language: intake.language,
        postAction: intake.action === "transcribe" ? "transcribe_only" : "transcribe_and_translate",
        subtitleIntakeRevision: intake.revision,
      },
    });
  }
  if (inputs.length) {
    runner.store.enqueue(inputs);
    runner.start();
  }
}
