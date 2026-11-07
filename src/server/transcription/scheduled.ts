import { embeddedVideoIdentity, VIDEO_SETTLE_MS } from "../embedded-subtitles.js";
import { assertSubtitleIntakeStillMissing } from "../subtitle-intake.js";
import { noSpeechVideos } from "../transcription-history.js";
import type { ScanResult } from "../scanner.js";
import type { TranscribePostAction } from "../transcription-client.js";
import { transcriptionWork, type WorkRunner } from "./work.js";

interface MissingTranscriptOptions {
  runner?: WorkRunner;
  silent?: (path: string) => boolean;
  requireSettled?: boolean;
  signal?: AbortSignal;
}

/** Shared by all scans. Automatic scans also wait for each video to settle. */
export async function enqueueMissingTranscripts(
  result: ScanResult,
  behavior: "ask" | "auto_transcribe" | "auto_transcribe_and_translate",
  {
    runner = transcriptionWork,
    silent = (path) => noSpeechVideos.has(path),
    requireSettled = false,
    signal,
  }: MissingTranscriptOptions = {},
): Promise<number> {
  if (behavior === "ask") return 0;
  const postAction: TranscribePostAction =
    behavior === "auto_transcribe_and_translate" ? "transcribe_and_translate" : "transcribe_only";
  const missing = result.files.flatMap(({ videoPath, subtitles, intake }) =>
    videoPath && !intake && subtitles.length === 0 && !silent(videoPath) ? [videoPath] : [],
  );
  const candidates = [];
  if (requireSettled) {
    const concurrency = 16;
    for (let start = 0; start < missing.length; start += concurrency) {
      signal?.throwIfAborted();
      const batch = await Promise.all(
        missing.slice(start, start + concurrency).map(async (input) => {
          const identity = await embeddedVideoIdentity(input).catch(() => null);
          return identity && Date.now() - identity.changedAt >= VIDEO_SETTLE_MS
            ? { input, videoRevision: identity.revision }
            : null;
        }),
      );
      for (const candidate of batch) if (candidate) candidates.push(candidate);
    }
  } else {
    for (const input of missing) candidates.push({ input, videoRevision: undefined });
  }

  signal?.throwIfAborted();
  if (candidates.length) {
    runner.store.enqueue(
      candidates.map(({ input, videoRevision }) => ({
        kind: "file",
        input,
        request: { postAction, ...(videoRevision && { videoRevision }) },
      })),
    );
    runner.start();
  }
  return candidates.length;
}

/** Execute only the explicit ASR decisions made by the shared intake pass. */
export async function enqueueIntakeTranscripts(result: ScanResult, signal?: AbortSignal, runner = transcriptionWork) {
  const inputs = [];
  for (const { videoPath, intake } of result.files) {
    signal?.throwIfAborted();
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
  signal?.throwIfAborted();
  if (inputs.length) {
    runner.store.enqueue(inputs);
    runner.start();
  }
}
