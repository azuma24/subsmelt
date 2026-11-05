export const SIDEBAR_WIDTH = { min: 100, max: 480, default: 256, keyStep: 16 } as const;

/** The share of the window the sidebar may take, so the jobs table keeps room on a small one. */
const SIDEBAR_MAX_WINDOW_SHARE = 0.4;

export function sidebarMaxWidth(windowWidth: number): number {
  return Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.round(windowWidth * SIDEBAR_MAX_WINDOW_SHARE)));
}

export function clampSidebarWidth(width: number, windowWidth: number): number {
  return Math.max(SIDEBAR_WIDTH.min, Math.min(sidebarMaxWidth(windowWidth), Math.round(width)));
}

/** A saved width, kept to the fixed limits only: the window it is shown in may be larger than this one. */
export function parseStoredWidth(raw: string | null): number {
  const width = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default;
  return Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.round(width)));
}

/** The width a key moves the separator to; null for a key it does not handle. */
export function widthAfterKey(key: string, width: number, windowWidth: number): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampSidebarWidth(width - SIDEBAR_WIDTH.keyStep, windowWidth);
    case "ArrowRight":
      return clampSidebarWidth(width + SIDEBAR_WIDTH.keyStep, windowWidth);
    case "Home":
      return SIDEBAR_WIDTH.min;
    case "End":
      return sidebarMaxWidth(windowWidth);
    default:
      return null;
  }
}
