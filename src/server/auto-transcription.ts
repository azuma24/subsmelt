// Videos that a POST /api/scan is auto-transcribing. Two overlapping scans see
// the same missing-subtitle videos; without this both would transcribe them.
const autoTranscribing = new Set<string>();

/** Claims and returns the videos no other scan is transcribing. Release each one when its run settles. */
export function claimAutoTranscriptions(videoPaths: string[]): string[] {
  const claimed = videoPaths.filter(
    (videoPath) => !autoTranscribing.has(videoPath),
  );
  for (const videoPath of claimed) autoTranscribing.add(videoPath);
  return claimed;
}

export function releaseAutoTranscription(videoPath: string): void {
  autoTranscribing.delete(videoPath);
}
