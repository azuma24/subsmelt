export const VIDEO_STATUSES = [
  "new",
  "queued",
  "downloading",
  "transcribing",
  "translating",
  "done",
  "waiting",
  "skipped",
  "unavailable",
  "failed",
] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export type SkipKind = "user" | "before_start" | "members_only";

/** Every allowed move. Anything not listed is refused by the store. */
const TRANSITIONS: Record<VideoStatus, readonly VideoStatus[]> = {
  new: ["queued", "skipped"],
  queued: ["downloading", "skipped"],
  downloading: ["transcribing", "queued", "waiting", "unavailable", "failed"],
  transcribing: ["translating", "transcribing", "failed"],
  translating: ["done"],
  done: ["queued"],
  waiting: ["queued"],
  skipped: ["queued"],
  unavailable: ["queued"],
  failed: ["queued"],
};

export function canTransition(from: VideoStatus, to: VideoStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
