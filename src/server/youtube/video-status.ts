import type { SkipKind, UserAction, VideoStatus } from "../../shared/youtube.js";

export { VIDEO_STATUSES } from "../../shared/youtube.js";
export type { SkipKind, UserAction, VideoStatus };

/** Every allowed move. Anything not listed is refused by the store. */
const TRANSITIONS: Record<VideoStatus, readonly VideoStatus[]> = {
  new: ["queued", "skipped"],
  queued: ["downloading", "skipped"],
  // skipped: a members-only video is only recognised once the download is refused.
  downloading: ["transcribing", "queued", "waiting", "unavailable", "failed", "skipped"],
  transcribing: ["translating", "transcribing", "failed"],
  translating: ["done"],
  done: ["queued"],
  waiting: ["queued", "skipped"],
  // new: a filter change releases a video on a manual playlist back to the user.
  skipped: ["queued", "new"],
  unavailable: ["queued"],
  failed: ["queued", "skipped"],
};

export function canTransition(from: VideoStatus, to: VideoStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** What each row action does, and from which statuses it is offered. */
export const USER_ACTIONS: Record<UserAction, { from: readonly VideoStatus[]; to: VideoStatus }> = {
  // From queued it only moves the video to the front of the lane.
  download: { from: ["new", "queued", "skipped", "waiting"], to: "queued" },
  retry: { from: ["failed", "unavailable"], to: "queued" },
  skip: { from: ["new", "queued", "waiting", "failed"], to: "skipped" },
};
