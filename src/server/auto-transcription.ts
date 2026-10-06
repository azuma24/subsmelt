import { inFlightTranscriptions } from "./transcription/in-flight.js";

// Videos that a POST /api/scan has queued for auto-transcription but may not
// have started yet. Two overlapping scans see the same missing-subtitle
// videos; without this both would transcribe them. Runs already started are
// in the in-flight registry, which a claim also respects.
const autoTranscribing = new Set<string>();

/** Claims and returns the videos no scan has queued and no run is transcribing. Release each one when its run settles. */
export function claimAutoTranscriptions(videoPaths: string[]): string[] {
  const claimed = videoPaths.filter(
    (videoPath) => !autoTranscribing.has(videoPath) && !inFlightTranscriptions.has(videoPath),
  );
  for (const videoPath of claimed) autoTranscribing.add(videoPath);
  return claimed;
}

export function releaseAutoTranscription(videoPath: string): void {
  autoTranscribing.delete(videoPath);
}
