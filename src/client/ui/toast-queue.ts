// Older toasts stay queued behind these and surface as newer ones go away, so
// a burst of failures never pushes the stack off the screen.
export const MAX_VISIBLE_TOASTS = 4;

interface QueuedToast {
  id: number;
  persistent?: boolean;
}

export function visibleToasts<T extends QueuedToast>(toasts: readonly T[]): T[] {
  return toasts.slice(-MAX_VISIBLE_TOASTS);
}

// Dismiss timers start when a toast becomes visible, not when it is queued,
// so a toast waiting behind a burst is still on screen for its full time.
export function toastsAwaitingTimer(toasts: readonly QueuedToast[], running: ReadonlySet<number>): number[] {
  return visibleToasts(toasts)
    .filter((toast) => !toast.persistent && !running.has(toast.id))
    .map((toast) => toast.id);
}
