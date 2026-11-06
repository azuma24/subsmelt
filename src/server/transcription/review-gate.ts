// The queue registers its gate at startup. Scanners and translation runners
// can consult it without importing the transcription runner.
type ReviewGate = (subtitlePath: string, videoPath: string | undefined, taskId?: number) => boolean;
type AddTarget = (subtitlePath: string, taskId: number) => void;
let gate: ReviewGate | undefined;
let active: (() => boolean) | undefined;
let addTarget: AddTarget | undefined;

export function registerSourceReviewGate(
  check: ReviewGate,
  hasRestrictions: () => boolean,
  remember?: AddTarget,
): void {
  gate = check;
  active = hasRestrictions;
  addTarget = remember;
}

export function isAutomaticTranslationAllowed(
  subtitlePath: string,
  videoPath: string | undefined,
  taskId: number,
): boolean {
  return gate?.(subtitlePath, videoPath, taskId) ?? true;
}

export function isSourceReviewPending(subtitlePath: string, videoPath?: string): boolean {
  return gate?.(subtitlePath, videoPath) === false;
}

export function allowExplicitTranslationTarget(subtitlePath: string, taskId: number): void {
  addTarget?.(subtitlePath, taskId);
}

export function hasAutomaticTranslationRestrictions(): boolean {
  return active?.() ?? false;
}
